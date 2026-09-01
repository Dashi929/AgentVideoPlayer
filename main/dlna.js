/**
 * 极简 DLNA/UPnP 投屏：SSDP 发现局域网内的 MediaRenderer，
 * 通过 SOAP SetAVTransportURI + Play 把视频推送到电视等设备。
 */
const dgram = require('dgram');
const http = require('http');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function searchRenderers(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = new Map(); // location -> friendlyName
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\nMX: 2\r\n' +
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n');
    const done = () => {
      try { sock.close(); } catch {}
      resolve([...found.entries()].map(([location, name]) => ({ location, name })));
    };
    sock.on('error', done);
    sock.on('message', (buf) => {
      const text = buf.toString();
      const loc = text.match(/LOCATION:\s*(\S+)/i)?.[1];
      if (loc && !found.has(loc)) {
        found.set(loc, loc); // 先占位，名字随后异步取
        fetchFriendlyName(loc).then(name => { if (name) found.set(loc, name); }).catch(() => {});
      }
    });
    sock.bind(() => {
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
    });
    setTimeout(done, timeoutMs);
  });
}

async function fetchFriendlyName(location) {
  const xml = await httpGet(location);
  const name = xml.match(/<friendlyName[^>]*>([^<]+)<\/friendlyName>/i)?.[1];
  return name || null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function soap(device, action, body) {
  return new Promise((resolve, reject) => {
    // 从设备描述 XML 中找 AVTransport controlURL
    httpGet(device.location).then((xml) => {
      const urlBase = xml.match(/<URLBase[^>]*>([^<]+)<\/URLBase>/i)?.[1] || new URL(device.location).origin;
      const ctrl = xml.match(/AVTransport[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i)?.[1];
      if (!ctrl) return reject(new Error('设备不支持 AVTransport'));
      const ctrlUrl = ctrl.startsWith('http') ? ctrl : urlBase + ctrl;
      const soapBody =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${body}</u:${action}></s:Body></s:Envelope>`;
      const u = new URL(ctrlUrl);
      const req = http.request({
        host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
        },
        timeout: 8000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.write(soapBody);
      req.end();
    }).catch(reject);
  });
}

function cast(device, url, title) {
  const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const meta =
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<item id="1" restricted="0"><dc:title>${esc(title)}</dc:title>` +
    `<upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:*">${esc(url)}</res></item></DIDL-Lite>`;
  return soap(device, 'SetAVTransportURI', `<InstanceID>0</InstanceID><CurrentURI>${esc(url)}</CurrentURI><CurrentURIMetaData>${meta}</CurrentURIMetaData>`)
    .then(() => soap(device, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>'));
}

module.exports = { searchRenderers, cast };
