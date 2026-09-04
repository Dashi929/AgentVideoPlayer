Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角方形背景（线性渐变 深蓝黑）
$rect = New-Object System.Drawing.Rectangle(8, 8, 240, 240)
$radius = 56
$d = $radius * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 40, 48, 68),
    [System.Drawing.Color]::FromArgb(255, 16, 20, 30), 90)
$g.FillPath($brush, $path)

# 播放三角（白色，重心略右移视觉居中）
$tri = @(
    (New-Object System.Drawing.Point(98, 74)),
    (New-Object System.Drawing.Point(98, 182)),
    (New-Object System.Drawing.Point(190, 128))
)
$g.FillPolygon([System.Drawing.Brushes]::White, $tri)

$g.Dispose()
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "PNG saved: $($args[0])"
