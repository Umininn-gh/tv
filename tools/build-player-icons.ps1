# Rebuild the extension's original TV icon without external image tools.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconOutput = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../browser-extension/icons'))
[System.IO.Directory]::CreateDirectory($iconOutput) | Out-Null

function Add-RoundedRectangle($path, [single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
}

$masterIcon = [System.Drawing.Bitmap]::new(512, 512)
$graphics = [System.Drawing.Graphics]::FromImage($masterIcon)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.ScaleTransform(4, 4)
$darkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#171D2D'))
$tealPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#48DCC3'), 6)
$tealPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$tealPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$bodyPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
Add-RoundedRectangle $bodyPath 18 28 92 76 16
$graphics.FillPath($darkBrush, $bodyPath)
$screenPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
Add-RoundedRectangle $screenPath 27 37 74 55 9
$graphics.DrawPath($tealPen, $screenPath)
$graphics.DrawLine($tealPen, 49, 19, 64, 29)
$graphics.DrawLine($tealPen, 79, 19, 64, 29)
$playPoints = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(55, 50),
    [System.Drawing.PointF]::new(55, 79),
    [System.Drawing.PointF]::new(80, 64.5)
)
$graphics.FillPolygon($whiteBrush, $playPoints)
foreach ($iconSize in @(16, 32, 48, 128)) {
    $iconBitmap = [System.Drawing.Bitmap]::new($iconSize, $iconSize)
    $iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
    $iconGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $iconGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $iconGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $iconGraphics.DrawImage($masterIcon, 0, 0, $iconSize, $iconSize)
    $iconBitmap.Save((Join-Path $iconOutput "icon$iconSize.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $iconGraphics.Dispose()
    $iconBitmap.Dispose()
}
$screenPath.Dispose()
$bodyPath.Dispose()
$whiteBrush.Dispose()
$tealPen.Dispose()
$darkBrush.Dispose()
$graphics.Dispose()
$masterIcon.Dispose()
Write-Output "Created extension icons in $iconOutput"
