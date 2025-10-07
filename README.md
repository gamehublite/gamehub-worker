# GameHub API - Cloudflare Worker

Privacy-respecting API proxy for the GameHub Android app. Routes requests to GitHub static files and proxies sensitive requests to Chinese servers while hiding your IP and sanitizing device fingerprints.

**Deployed at:** `https://gamehub-api.secureflex.workers.dev`

**⚠️ IMPORTANT: If you want 100% privacy and don't trust the worker instance I hosted, you can host this yourself! See [Self-Hosting](#self-hosting) section below.**

---

## What This Does

This Cloudflare Worker acts as a smart proxy between the GameHub app and data sources:

1. **Static data** (components, configs) → Served from GitHub (fast, no tracking)
2. **Game metadata** → Proxied to Chinese server (hides your IP)
3. **GPU configs** → Proxied with sanitized device info (removes fingerprinting)
4. **Downloads** → Direct CDN links (no proxy, no logging)

---

## Architecture

```
[GameHub App]
     ↓
[Cloudflare Worker] ← You are here
     ↓
     ├─→ GitHub (static data: manifests, configs)
     ├─→ Chinese Server (game metadata, GPU configs) [Your IP hidden]
     └─→ Returns direct CDN links (app downloads directly)
```

---

## API Endpoints

### 1. Component List
**Endpoint:** `POST /simulator/v2/getComponentList`

Returns paginated list of downloadable components (Box64, drivers, DXVK, etc.)

**Request:**
```json
{
  "type": 1,
  "page": 1,
  "page_size": 10
}
```

**Component Types:**
- `1` - Box64 (x86_64 emulator)
- `2` - GPU Drivers (Mali, Adreno, PowerVR)
- `3` - DXVK (DirectX to Vulkan)
- `4` - VKD3D (Direct3D 12 to Vulkan)
- `5` - Game Profiles
- `6` - Windows Libraries
- `7` - Steam Integration

**Data Source:** GitHub (`/components/{type}_manifest`)

**Response:**
```json
{
  "code": 200,
  "msg": "Success",
  "data": {
    "list": [...],
    "page": 1,
    "pageSize": 10,
    "total": 50
  }
}
```

---

### 2. Game Details
**Endpoint:** `POST /card/getGameDetail`

Fetches game metadata (title, description, images, etc.)

**Data Source:** Chinese server (landscape-api.vgabc.com)

**Privacy:** Your IP is hidden - Chinese server sees Cloudflare's IP instead

**Request:**
```json
{
  "game_id": "123",
  "token": "your-token"
}
```

---

### 3. GPU Configuration
**Endpoint:** `POST /simulator/executeScript`

Gets optimal game settings based on GPU vendor.

**Data Source:** Chinese server (landscape-api.vgabc.com)

**Privacy Protection:** Device fingerprint is **sanitized** before proxying

**What gets stripped:**
- Device model → `"Generic Device"`
- GPU model → `"0"`
- Driver version → `0`
- Device-specific identifiers

**What's kept:**
- GPU vendor (needed for config: `"Qualcomm"`, `"Mali"`, `"Adreno"`)

**Request (from app):**
```json
{
  "gpu_vendor": "Qualcomm",
  "gpu_device_name": "Adreno 660",
  "gpu_version": 512,
  "gpu_system_driver_version": "512.0.0",
  "game_id": "123"
}
```

**Request (sent to server):**
```json
{
  "gpu_vendor": "Qualcomm",
  "gpu_device_name": "Generic Device",
  "gpu_version": 0,
  "gpu_system_driver_version": 0,
  "game_id": "0"
}
```

---

### 4. Base Configuration
**Endpoint:** `POST /base/getBaseInfo`

Returns app configuration (switches, guide images, etc.)

**Data Source:** GitHub (`/base/getBaseInfo`)

---

### 5. Steam CDN Hosts
**Endpoint:** `GET /game/getSteamHost`

Returns optimized Steam CDN IP addresses (hosts file format)

**Data Source:** GitHub (`/game/getSteamHost/index`)

**Response:** Plain text hosts file
```
23.47.27.74         steamcommunity.com
104.94.121.98       www.steamcommunity.com
23.45.149.185       store.steampowered.com
```

---

### 6. Cloud Sync Timer
**Endpoint:** `POST /cloud/game/check_user_timer`

Checks Steam cloud sync timer status

**Data Source:** GitHub (`/cloud/game/check_user_timer`)

---

### 7. DNS IP Pool
**Endpoint:** `POST /game/getDnsIpPool`

Returns DNS pool (empty - allows direct Steam connections)

**Data Source:** GitHub (`/game/getDnsIpPool`)

---

### 8. News List
**Endpoint:** `POST /card/getNewsList`

Returns news/promotions (empty list - promotional content removed)

**Data Source:** Worker-generated

**Response:**
```json
{
  "code": 200,
  "msg": "",
  "data": []
}
```

---

### 9. Game Icons
**Endpoint:** `POST /card/getGameIcon`

Returns game icons (empty - UI feature, not critical)

**Data Source:** Worker-generated

---

### 10. Fallback Handler
**Endpoint:** All other requests

Proxies directly to GitHub with 5-minute caching

**Data Source:** GitHub (`https://raw.githubusercontent.com/gamehublite/gamehub_api/main/*`)

---

## Privacy Features

### 1. IP Address Protection
```
Original:
User (123.45.67.89) → Chinese Server [TRACKED]

With Worker:
User (123.45.67.89) → Cloudflare → Chinese Server
Server sees: Cloudflare IP (104.21.x.x) [USER IP HIDDEN]
```

### 2. Device Fingerprint Sanitization
Only GPU vendor is sent for configuration:
- ✅ Keeps: `gpu_vendor: "Qualcomm"`
- ❌ Strips: Device model, GPU model, driver version, all identifiers

### 3. No Download Proxying
Component downloads are **direct from CDN**:
- Worker only provides download URLs
- User downloads directly from CDN
- Worker never sees download traffic
- Your IP is not logged

### 4. Caching
GitHub responses cached for 5 minutes:
- Reduces API calls
- Faster response times
- Less server load

---

## Self-Hosting

### **Want 100% Privacy? Host It Yourself!**

If you don't want to trust my hosted instance, you can deploy your own Cloudflare Worker in under 5 minutes. It's **completely free** (100k requests/day on free tier).

#### Prerequisites
```bash
npm install -g wrangler
wrangler login  # Sign in with your Cloudflare account (free)
```

#### Deploy Your Own Instance
```bash
# Clone or download this repository
cd gamehub-api

# Install dependencies
npm install

# Deploy to YOUR Cloudflare account
npm run deploy
```

**Output:**
```
Deployed gamehub-api
  https://gamehub-api-YOUR-NAME.workers.dev
```

#### Update APK to Use Your Worker

Edit `smali_classes4/com/xj/common/http/EggGameHttpConfig.smali`:

**Find:**
```smali
const-string v0, "https://gamehub-api.secureflex.workers.dev/"
```

**Replace with your URL:**
```smali
const-string v0, "https://gamehub-api-YOUR-NAME.workers.dev/"
```

Recompile and sign the APK. Now **you control the entire stack** - no third parties!

---

## Public Deployment (Using My Instance)

If you trust my hosted instance, you can use it directly:

**Deployed at:** `https://gamehub-api.secureflex.workers.dev`

### Development
```bash
npm run dev
# Local server: http://localhost:8787
```

---

## Configuration

### wrangler.jsonc
```json
{
  "name": "gamehub-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-10-03",
  "assets": { "directory": "./public" },
  "observability": { "enabled": true }
}
```

### GitHub Static API
**Repository:** `https://github.com/gamehublite/gamehub_api`

**Structure:**
```
gamehub_api/
├── base/getBaseInfo
├── components/
│   ├── box64_manifest
│   ├── drivers_manifest
│   ├── dxvk_manifest
│   ├── vkd3d_manifest
│   ├── games_manifest
│   ├── libraries_manifest
│   └── steam_manifest
├── game/
│   ├── getDnsIpPool
│   └── getSteamHost/index
└── cloud/game/check_user_timer
```

---

## Request Flow Example

**App requests Box64 components:**

1. App sends:
   ```
   POST /simulator/v2/getComponentList
   { "type": 1, "page": 1, "page_size": 10 }
   ```

2. Worker routes to GitHub:
   ```
   GET https://raw.githubusercontent.com/gamehublite/gamehub_api/main/components/box64_manifest
   ```

3. GitHub returns manifest with 11 Box64 versions

4. Worker paginates and transforms:
   ```json
   {
     "data": {
       "list": [ /* 10 items */ ],
       "page": 1,
       "pageSize": 10,
       "total": 11
     }
   }
   ```

5. App receives response and downloads components **directly from CDN**:
   ```
   https://zlyer-cdn-comps-en.bigeyes.com/.../box64.tzst
   ```

6. Worker is **not involved** in download (no logging, no tracking)

---

## Privacy Score

**Before:** 0/10
- All requests to Chinese servers
- User IP logged everywhere
- Full device fingerprint sent
- Analytics tracking active

**After:** 10/10
- Requests to Cloudflare (privacy-respecting)
- User IP hidden from Chinese servers
- Device fingerprint sanitized
- Analytics completely removed
- Downloads direct from CDN (no proxy)
- All code open source and auditable

---

## Technical Details

**Language:** TypeScript
**Runtime:** Cloudflare Workers
**Size:** 287 lines
**Dependencies:** None (zero runtime dependencies)
**Deployment:** Edge network (fast worldwide)
**Cost:** Free tier (100k requests/day)

---

## Development

### Run Tests
```bash
npm test
```

### Local Development
```bash
npm run dev
```

### Type Checking
```bash
npm run cf-typegen
```

---

## Maintenance

### Update Component Manifests
1. Edit files in `gamehub_api` repository
2. Commit and push to GitHub
3. Changes propagate automatically:
   - GitHub: < 10 seconds
   - Cloudflare cache: 5 minutes
   - App receives: Next request

### Monitor
Cloudflare Dashboard:
- Request counts
- Error rates
- Response times
- Geographic distribution

---

## Security

**CORS:** Enabled for all origins (`*`)
**HTTPS:** Enforced by Cloudflare
**Caching:** 5-minute TTL for GitHub responses
**Error Handling:** All errors caught and returned as JSON

---

## License

MIT - Educational purposes only

---

## Related Repositories

- **Static API Data:** `https://github.com/gamehublite/gamehub_api`
- **Modified APK Analysis:** See main documentation

---

**For questions or issues, see the main GameHub APK analysis documentation.**
