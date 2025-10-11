# GameHub API Proxy Worker

Main Cloudflare Worker that proxies all GameHub app API requests, handles automatic token replacement with signature regeneration, and provides privacy-focused features.

**Deployed at:** `https://gamehub-api.secureflex.workers.dev`

---

## Features

- 🔄 **Automatic Token Replacement**: Detects "fake-token" and replaces with real token from token-refresher
- 🔐 **Signature Regeneration**: Recalculates MD5 signatures after token replacement
- 🎮 **Game Details Proxy**: Forwards game data requests to Chinese servers
- 📰 **News Aggregation**: Routes news requests to news-aggregator worker
- 🛡️ **Privacy Protection**: Sanitizes device fingerprints before forwarding
- 📦 **Component Manifests**: Serves Wine/Proton/DXVK configs from GitHub
- 🚫 **UI Cleanup**: Removes recommended games and tracking sections
- 💾 **Smart Caching**: 5-minute cache for GitHub content

---

## System Architecture

```
📱 GameHub App (sends "fake-token")
        ↓
☁️ gamehub-api worker
    ├── Detects fake-token in request
    ├── Fetches real token from token-refresher
    ├── Regenerates MD5 signature
    ├── Sanitizes device fingerprints
    └── Routes to appropriate backend
        ↓
    ┌───┴────┬──────────┬────────────┐
    ↓        ↓          ↓            ↓
Chinese   News      GitHub      Direct
API      Worker   (Components)  Response
```

---

## Token Replacement System

### How It Works

The app sends `"token": "fake-token"` in every request. The worker:

1. **Detects** "fake-token" in POST body
2. **Fetches** real token from token-refresher worker
3. **Replaces** fake-token → real token
4. **Regenerates** MD5 signature with new token
5. **Forwards** to Chinese server with valid auth

### Example Transformation

**Before (from app)**:
```json
{
  "token": "fake-token",
  "sign": "abc123...",
  "time": "1760032301893",
  "app_id": "585690",
  "clientparams": "5.1.0|16|en|..."
}
```

**After (to server)**:
```json
{
  "token": "f589a94e-fec5-4aea-a96b-115ecdfd50d8",
  "sign": "6e5092f2c5d40eb8a8ba66313982847a",  ← Regenerated
  "time": "1760032301893",
  "app_id": "585690",
  "clientparams": "5.1.0|16|en|..."
}
```

### Signature Algorithm

**Secret Key**: `all-egg-shell-y7ZatUDk` (discovered via APK reverse engineering)

```javascript
function generateSignature(params) {
  const SECRET_KEY = 'all-egg-shell-y7ZatUDk';

  // Sort parameters alphabetically (exclude 'sign')
  const sortedKeys = Object.keys(params)
    .filter(k => k !== 'sign')
    .sort();

  // Join as key=value&key=value
  const paramString = sortedKeys
    .map(key => `${key}=${params[key]}`)
    .join('&');

  // Append secret key
  const signString = `${paramString}&${SECRET_KEY}`;

  // MD5 hash (lowercase)
  return md5(signString).toLowerCase();
}
```

---

## API Endpoints

### POST /card/getGameDetail
Get game details (proxied with token replacement)

**Features**:
- Replaces fake-token with real token
- Regenerates signature
- Removes `recommend_game` section
- Removes `card_line_data` tracking

**Privacy**: Your IP hidden from Chinese server

---

### POST /card/getNewsList
Get news list (routed to news-aggregator worker)

**Request**:
```json
{
  "page": 1,
  "page_size": 4
}
```

**Response**: Gaming news from RSS feeds + GitHub releases

---

### POST /card/getNewsGuideDetail
Get full news article (routed to news-aggregator worker)

**Request**:
```json
{
  "id": 1
}
```

**Response**: Full article HTML with mobile-optimized styling

---

### POST /simulator/executeScript
Get Steam game configuration (with privacy protection)

**Sanitization**:
```javascript
// Original (from app)
{
  gpu_vendor: "Qualcomm",
  gpu_device_name: "Adreno 750",
  gpu_system_driver_version: "615.0",
  token: "fake-token"
}

// Sanitized (sent to server)
{
  gpu_vendor: "Qualcomm",         // Only field needed
  gpu_device_name: "Generic Device",
  gpu_system_driver_version: 0,
  token: "f589a94e-..."            // Real token
}
```

**Privacy**: Device fingerprint stripped, only GPU vendor sent

---

### POST /simulator/v2/getComponentList
Get component manifests (Wine, Proton, DXVK, etc.)

**Component Types**:
- `1` - Box64 (x86_64 emulator)
- `2` - GPU Drivers
- `3` - DXVK (DirectX to Vulkan)
- `4` - VKD3D (Direct3D 12)
- `5` - Game Profiles
- `6` - Windows Libraries
- `7` - Steam Integration

**Source**: GitHub (`gamehublite/gamehub_api`)
**Cache**: 5 minutes

---

### POST /base/getBaseInfo
Get app configuration

**Source**: GitHub repository

---

### POST /cloud/game/check_user_timer
Check cloud save timer

**Source**: GitHub repository

---

### GET /game/getSteamHost
Get Steam CDN hosts

**Source**: GitHub repository
**Format**: Plain text hosts file

---

### POST /game/getDnsIpPool
Get DNS pool (empty for real Steam connections)

**Source**: GitHub repository

---

### POST /card/getGameIcon
Get game icons (empty response, UI feature)

---

## Integration with Other Workers

### Token Refresher Worker
```javascript
// Fetch real token with auth header
const tokenResponse = await fetch(`${env.TOKEN_REFRESHER_URL}/token`, {
  headers: {
    'X-Worker-Auth': 'gamehub-internal-token-fetch-2025'
  }
});

const { token } = await tokenResponse.json();
// token: "f589a94e-fec5-4aea-a96b-115ecdfd50d8"
```

### News Aggregator Worker
```javascript
// Forward news requests
const newsResponse = await fetch(
  `${NEWS_AGGREGATOR_URL}/api/news/list?page=${page}&page_size=${pageSize}`
);
```

---

## Privacy Features

### 1. IP Address Protection
```
Original:
User (123.45.67.89) → Chinese Server [TRACKED]

With Worker:
User (123.45.67.89) → Cloudflare → Chinese Server
Server sees: Cloudflare IP [USER IP HIDDEN]
```

### 2. Device Fingerprint Sanitization
- ✅ Keeps: GPU vendor (needed for configs)
- ❌ Strips: Device model, GPU model, driver version, all identifiers

### 3. Automatic Token Management
- No login required (tokens managed by separate worker)
- Tokens refreshed every 4 hours automatically
- Never expires

### 4. No Download Proxying
- Component downloads are direct from CDN
- Worker only provides URLs
- Your IP not logged in download requests

---

## Setup

### 1. Install Dependencies
```bash
cd gamehub-api
npm install
```

### 2. Configure Environment Variables

Edit `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "TOKEN_REFRESHER_URL": "https://gamehub-token-refresher.YOUR_SUBDOMAIN.workers.dev"
  }
}
```

### 3. Deploy
```bash
npm run deploy
```

### 4. Update APK Base URL

In modified APK, change base URL to:
```
https://gamehub-api.YOUR_SUBDOMAIN.workers.dev
```

---

## Monitoring

### View Real-Time Logs
```bash
npm run tail
```

**Expected logs**:
```
[TOKEN] Detected fake-token, fetching real token...
[TOKEN] Replacing fake-token with real token: f589a94e-...
[TOKEN] Replaced fake-token and regenerated signature
```

### Check Deployment Status
```bash
npx wrangler deployments list
```

### View Analytics
Cloudflare Dashboard → Workers & Pages → gamehub-api → Metrics

---

## Development

### Run Locally
```bash
npm run dev
```

Visit: `http://localhost:8787`

### Test Token Replacement
```bash
curl -X POST http://localhost:8787/card/getGameDetail \
  -H "Content-Type: application/json" \
  -d '{
    "token": "fake-token",
    "sign": "test",
    "time": "1760032301893",
    "app_id": "585690"
  }'
```

---

## Configuration

### Environment Variables (wrangler.jsonc)
```jsonc
{
  "vars": {
    "TOKEN_REFRESHER_URL": "https://gamehub-token-refresher.secureflex.workers.dev"
  }
}
```

### Constants (src/index.ts)
```typescript
const GITHUB_BASE = 'https://raw.githubusercontent.com/gamehublite/gamehub_api/main';
const NEWS_AGGREGATOR_URL = 'https://gamehub-news-aggregator.secureflex.workers.dev';
const GAMEHUB_SECRET_KEY = 'all-egg-shell-y7ZatUDk';
```

---

## Error Handling

| Scenario | Response | Action |
|----------|----------|--------|
| Token fetch fails | Log error | Continue (will fail at server) |
| Signature generation fails | Log error | Forward original request |
| GitHub fetch fails | 500 error | Client retries |
| News worker down | Empty news | Client shows empty state |
| Chinese API down | Forward error | Client shows error |

---

## Performance

- **Cold Start**: ~100ms
- **Token Replacement**: ~200ms (includes fetch from token-refresher)
- **Signature Generation**: <5ms
- **GitHub Proxy**: ~300ms (cached)
- **News Proxy**: ~50ms (cached at news worker)
- **Memory**: <20MB
- **Cost**: Free tier (< 100k requests/day)

---

## Troubleshooting

### "Wrong signature" Error
1. Check token is being replaced (view logs)
2. Verify signature algorithm matches server
3. Ensure secret key is correct: `all-egg-shell-y7ZatUDk`
4. Check parameters sorted alphabetically

### Token Not Being Replaced
1. Verify app sends "fake-token" exactly
2. Check token-refresher is responding
3. Test auth header: `X-Worker-Auth: gamehub-internal-token-fetch-2025`
4. Review worker logs for errors

### News Not Loading
1. Check news-aggregator worker is deployed
2. Verify `NEWS_AGGREGATOR_URL` is correct
3. Test news endpoint directly

### Components Not Loading
1. Verify GitHub repository exists
2. Check manifest files in repo
3. Test GitHub URLs directly

---

## Security Considerations

1. **Token Security**: Protected by auth header to token-refresher
2. **Signature Validation**: Proper MD5 signatures prevent tampering
3. **Device Privacy**: Fingerprints sanitized before forwarding
4. **CORS**: Open for app access (not a security concern for proxy)
5. **Input Validation**: JSON parsing with error handling

---

## APK Integration

### Required APK Modifications

1. **Base URL Change**:
   ```smali
   # Change in network config
   const-string v0, "https://gamehub-api.secureflex.workers.dev"
   ```

2. **Token Hardcode**:
   ```smali
   # UserManager.smali:508
   const-string v0, "fake-token"
   ```

### Testing the Integration

1. Decompile APK with apktool
2. Modify base URL and token
3. Recompile and sign APK
4. Install on device
5. Monitor worker logs while using app

---

## Self-Hosting

Want 100% privacy? Deploy your own instance:

```bash
# Clone repository
cd gamehub-api

# Install dependencies
npm install

# Deploy to YOUR Cloudflare account
npm run deploy
```

Output:
```
Deployed gamehub-api
  https://gamehub-api-YOUR-NAME.workers.dev
```

Update APK to use your worker URL!

---

## Related Components

- **Token Refresher**: Automatically refreshes tokens every 4 hours
- **News Aggregator**: Provides gaming news from RSS/GitHub
- **GitHub Static API**: Component manifests and configs

---

## Notes

- All requests pass through this worker (main proxy)
- Token replacement happens transparently
- Signature regeneration prevents authentication errors
- Privacy features strip identifying information
- GitHub components avoid Chinese server dependency
- News aggregation provides custom content
- Compatible with Cloudflare Free tier

---

## Future Improvements

1. **Request Caching**: Cache identical requests
2. **Rate Limiting**: Prevent abuse
3. **Metrics**: Track token replacement success rate
4. **Error Retry**: Automatic retry for token fetch failures
5. **Token Validation**: Verify token works before using
6. **Fallback**: Use cached old token if fetch fails

---

**For questions or issues, see the main GameHub documentation.**
