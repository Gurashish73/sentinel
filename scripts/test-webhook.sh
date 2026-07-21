#!/bin/bash

# 1. Replace with the actual decrypted secret you set in the Commander Settings UI
SECRET="your-webhook-secret-here"
# 2. Replace with your actual org slug
ORG_SLUG="your-org-slug"

# 3. Define the exact raw JSON body
BODY='{"title":"DB connection pool exhausted","severity":"HIGH","source":"synthetic-cli","externalId":"cli-test-001"}'

# 4. Compute the HMAC SHA-256 signature
# We use `printf` instead of `echo` to guarantee no hidden carriage returns (\r\n) 
# are injected on Windows/WSL, which would completely corrupt the cryptographic hash.
SIG=$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

echo "🚀 Sending Webhook to /api/webhooks/alert/$ORG_SLUG"
echo "🔑 Computed Signature: sha256=$SIG"
echo "----------------------------------------"

# 5. Fire the POST request
# Notice the sha256= prefix. This tests our normalization logic!
curl -i -X POST http://localhost:3000/api/webhooks/alert/$ORG_SLUG \
  -H "Content-Type: application/json" \
  -H "x-signature: sha256=$SIG" \
  -d "$BODY"

echo -e "\n----------------------------------------"
echo "✅ Test complete."
echo "💡 Run this exact script again to test idempotency (it should return 200 with status: 'duplicate')."