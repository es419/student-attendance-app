param(
  [Parameter(Mandatory=$true)][string]$BotToken,
  [Parameter(Mandatory=$true)][string]$WebhookSecret
)

$ProjectRef = 'ojzemdselyxxscbbvssm'
$WebhookUrl = "https://$ProjectRef.supabase.co/functions/v1/attendance-telegram"
$ApiUrl = "https://api.telegram.org/bot$BotToken/setWebhook"

$body = @{
  url = $WebhookUrl
  secret_token = $WebhookSecret
  allowed_updates = @('message','callback_query')
  drop_pending_updates = $true
} | ConvertTo-Json

$result = Invoke-RestMethod -Method Post -Uri $ApiUrl -ContentType 'application/json' -Body $body
$result | ConvertTo-Json -Depth 5
