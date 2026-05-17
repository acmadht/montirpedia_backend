Write-Host "====================================="
Write-Host "TEST AI MONTIR PEDIA"
Write-Host "====================================="

$baseUrl = "http://localhost:3000"

Write-Host ""
Write-Host "1. Mengecek backend..."
Write-Host ""

try {
  $serverCheck = Invoke-RestMethod `
    -Uri "$baseUrl/" `
    -Method GET

  Write-Host "Backend online."
  Write-Host "App:" $serverCheck.app
  Write-Host "AI Endpoint:" $serverCheck.aiEndpoint
}
catch {
  Write-Host "Backend belum aktif."
  Write-Host "Jalankan dulu: npm start"
  exit
}

Write-Host ""
Write-Host "2. Mengecek Gemini API Key..."
Write-Host ""

try {
  $envCheck = Invoke-RestMethod `
    -Uri "$baseUrl/api/env-check" `
    -Method GET

  Write-Host "AI Provider:" $envCheck.aiProvider
  Write-Host "Gemini Model:" $envCheck.geminiModel
  Write-Host "Has Gemini Key:" $envCheck.hasGeminiKey
  Write-Host "Gemini Key Prefix:" $envCheck.geminiKeyPrefix

  if ($envCheck.hasGeminiKey -ne $true) {
    Write-Host ""
    Write-Host "GEMINI_API_KEY belum terbaca."
    Write-Host "Periksa file .env."
    exit
  }
}
catch {
  Write-Host "Endpoint /api/env-check belum aktif."
  Write-Host "Pastikan index.js sudah versi terbaru."
  exit
}

Write-Host ""
Write-Host "3. Mengetes Chat AI..."
Write-Host ""

$body = @{
  message = "Motor saya susah hidup, harus bagaimana?"
  history = @()
  user = @{
    name = "Hylmi"
  }
  appContext = @{
    appName = "Montir Pedia"
    features = @(
      "Booking Jadwal",
      "Home Service",
      "Jemput Antar",
      "Bengkel Terdekat",
      "Status Servis",
      "Chat CS"
    )
  }
} | ConvertTo-Json -Depth 10

try {
  $response = Invoke-RestMethod `
    -Uri "$baseUrl/api/ai-chat" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body

  Write-Host ""
  Write-Host "AI BERHASIL CONNECT."
  Write-Host ""
  Write-Host "Provider:" $response.provider
  Write-Host "Model:" $response.model
  Write-Host ""
  Write-Host "Jawaban AI:"
  Write-Host $response.reply
}
catch {
  Write-Host ""
  Write-Host "AI MASIH ERROR."
  Write-Host ""

  if ($_.Exception.Response) {
    Write-Host "STATUS:" $_.Exception.Response.StatusCode.value__

    Write-Host ""
    Write-Host "ERROR DETAIL:"
    Write-Host $_.ErrorDetails.Message

    if ($_.ErrorDetails.Message -like "*API key not valid*") {
      Write-Host ""
      Write-Host "PENYEBAB:"
      Write-Host "GEMINI_API_KEY tidak valid."
      Write-Host ""
      Write-Host "SOLUSI:"
      Write-Host "1. Buat API key baru di Google AI Studio."
      Write-Host "2. Ganti GEMINI_API_KEY di file .env."
      Write-Host "3. Restart backend dengan npm start."
    }

    if ($_.ErrorDetails.Message -like "*quota*") {
      Write-Host ""
      Write-Host "PENYEBAB:"
      Write-Host "Kuota Gemini habis atau project belum aktif."
    }
  } else {
    Write-Host $_.Exception.Message
  }
}