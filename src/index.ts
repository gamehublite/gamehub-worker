/**
 * GameHub API Proxy Worker
 * Routes POST requests with type parameter to correct GitHub manifest files
 * Provides Steam game configs based on GPU vendor (NO Chinese server involvement)
 * Proxies CDN downloads to hide user IP from Chinese servers
 */

import { md5 } from './md5.js';

const GITHUB_BASE = 'https://raw.githubusercontent.com/gamehublite/gamehub_api/main';
const WORKER_URL = 'https://gamehub-api.secureflex.workers.dev';
const NEWS_AGGREGATOR_URL = 'https://gamehub-news-aggregator.secureflex.workers.dev';
const GAMEHUB_SECRET_KEY = 'all-egg-shell-y7ZatUDk';

// Generate signature for GameHub API requests
function generateSignature(params: Record<string, any>): string {
	const sortedKeys = Object.keys(params).filter(k => k !== 'sign').sort();
	const paramString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
	const signString = `${paramString}&${GAMEHUB_SECRET_KEY}`;
	return md5(signString).toLowerCase();
}

// Map component types to their manifest files
const TYPE_TO_MANIFEST: Record<number, string> = {
	1: '/components/box64_manifest',
	2: '/components/drivers_manifest',
	3: '/components/dxvk_manifest',
	4: '/components/vkd3d_manifest',
	5: '/components/games_manifest',
	6: '/components/libraries_manifest',
	7: '/components/steam_manifest',
};

// CDN proxying removed - components now download directly from source

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Enable CORS for all requests
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// ============================================================
			// TOKEN INTERCEPTION - Replace "fake-token" with real token
			// ============================================================
			let modifiedRequest = request;
			let shouldReplaceToken = false;
			let bodyText = '';

			// Check if request contains "fake-token" in headers or body
			const authHeader = request.headers.get('Authorization');
			const tokenHeader = request.headers.get('token');

			// Check headers first
			if (authHeader?.includes('fake-token') || tokenHeader === 'fake-token') {
				shouldReplaceToken = true;
			}

			// Check POST body for fake-token
			if (request.method === 'POST' && request.headers.get('Content-Type')?.includes('application/json')) {
				bodyText = await request.clone().text();
				if (bodyText.includes('fake-token')) {
					shouldReplaceToken = true;
				}
			}

			// Only fetch real token if fake-token was found
			if (shouldReplaceToken) {
				// Try to get cached token first
				const cacheKey = new Request(`${env.TOKEN_REFRESHER_URL}/token-cached`);
				const cache = caches.default;
				let cachedResponse = await cache.match(cacheKey);

				let realToken: string;

				if (cachedResponse) {
					// Use cached token
					const cachedData = await cachedResponse.json();
					realToken = cachedData.token;
					console.log('[TOKEN] Using cached token:', realToken);
				} else {
					// Cache miss - fetch fresh token
					console.log('[TOKEN] Cache miss, fetching fresh token from refresher...');

					const tokenResponse = await fetch(`${env.TOKEN_REFRESHER_URL}/token`, {
						headers: {
							'X-Worker-Auth': 'gamehub-internal-token-fetch-2025'
						}
					});

					if (tokenResponse.ok) {
						const tokenData = await tokenResponse.json();
						realToken = tokenData.token;

						// Cache the token for 4 hours (14400 seconds)
						const cacheResponse = new Response(JSON.stringify(tokenData), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': 'public, max-age=14400'
							}
						});

						ctx.waitUntil(cache.put(cacheKey, cacheResponse));
						console.log('[TOKEN] Fetched and cached new token:', realToken);
					} else {
						console.error('[TOKEN] Failed to fetch real token from refresher');
					}
				}

				if (realToken) {
					console.log('[TOKEN] Replacing fake-token with real token');

					// Clone request to modify headers/body
					const newHeaders = new Headers(request.headers);

					// Replace token in headers if present
					if (authHeader?.includes('fake-token')) {
						newHeaders.set('Authorization', authHeader.replace('fake-token', realToken));
					}
					if (tokenHeader === 'fake-token') {
						newHeaders.set('token', realToken);
					}

					// Replace token in POST body if present
					if (bodyText && bodyText.includes('fake-token')) {
						// Parse the body as JSON to regenerate signature
						const bodyJson = JSON.parse(bodyText);
						bodyJson.token = realToken;

						// Regenerate signature with new token
						const newSignature = generateSignature(bodyJson);
						bodyJson.sign = newSignature;

						const modifiedBody = JSON.stringify(bodyJson);
						console.log('[TOKEN] Replaced fake-token and regenerated signature');

						modifiedRequest = new Request(request.url, {
							method: request.method,
							headers: newHeaders,
							body: modifiedBody,
						});
					} else if (bodyText) {
						modifiedRequest = new Request(request.url, {
							method: request.method,
							headers: newHeaders,
							body: bodyText,
						});
					} else {
						modifiedRequest = new Request(request.url, {
							method: request.method,
							headers: newHeaders,
						});
					}
				} else {
					console.error('[TOKEN] Failed to fetch real token from refresher');
				}
			}

			// Use modifiedRequest for all subsequent operations
			request = modifiedRequest;
			// ============================================================
			// API ENDPOINTS
			// ============================================================

			// Proxy /card/getGameDetail to Chinese server
			if (url.pathname === '/card/getGameDetail' && request.method === 'POST') {
				const bodyText = await request.text();

				// Forward request to Chinese server with all original headers (for signature)
				const chineseResponse = await fetch('https://landscape-api.vgabc.com/card/getGameDetail', {
					method: 'POST',
					headers: request.headers,
					body: bodyText,
				});

				const responseData = await chineseResponse.json();

				// Remove recommended games section to clean up UI
				if (responseData.data) {
					delete responseData.data.recommend_game;
					delete responseData.data.card_line_data;
				}

				// Return the Chinese server response with recommended section removed
				return new Response(JSON.stringify(responseData), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle /card/getNewsList endpoint - Forward to news aggregator
			if (url.pathname === '/card/getNewsList' && request.method === 'POST') {
				const body = await request.json() as { page?: number; page_size?: number };
				const page = body.page || 1;
				const pageSize = body.page_size || 4; // Default to 4 items for lazy loading

				// Forward to news aggregator worker
				const newsResponse = await fetch(
					`${NEWS_AGGREGATOR_URL}/api/news/list?page=${page}&page_size=${pageSize}`
				);

				if (!newsResponse.ok) {
					return new Response(JSON.stringify({
						code: 500,
						msg: "Failed to fetch news",
						time: "",
						data: []
					}), {
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const newsData = await newsResponse.json();
				return new Response(JSON.stringify(newsData), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle /card/getNewsGuideDetail endpoint - Forward to news aggregator
			if (url.pathname === '/card/getNewsGuideDetail' && request.method === 'POST') {
				const body = await request.json() as { id?: number; source?: string };
				const newsId = body.id;

				if (!newsId) {
					return new Response(JSON.stringify({
						code: 400,
						msg: "Missing id parameter",
						time: "",
						data: null
					}), {
						status: 400,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				// Forward to news aggregator worker
				const newsDetailResponse = await fetch(
					`${NEWS_AGGREGATOR_URL}/api/news/detail/${newsId}`
				);

				if (!newsDetailResponse.ok) {
					return new Response(JSON.stringify({
						code: 404,
						msg: "News not found",
						time: "",
						data: null
					}), {
						status: 404,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const newsDetailData = await newsDetailResponse.json();
				return new Response(JSON.stringify(newsDetailData), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Proxy /simulator/executeScript to Chinese server (with privacy protection)
			if (url.pathname === '/simulator/executeScript' && request.method === 'POST') {
				const body = await request.json();

				// Sanitize request - ONLY send gpu_vendor, strip device fingerprint
				// The API only uses gpu_vendor to decide which components to return
				const sanitizedBody = {
					gpu_vendor: body.gpu_vendor,  // ← ONLY real field needed for config!
					gpu_version: 0,  // Generic
					gpu_device_name: "Generic Device",
					game_type: body.game_type || 2,
					token: body.token,  // Required for API auth
					game_id: "0",  // Generic game ID
					sign: body.sign,  // Required for request validation
					time: body.time,
					clientparams: "5.1.0|0|en|Generic|1920*1080|app|app|generic|||||||||com.app|Generic|generic",
					gpu_system_driver_version: 0
				};

				console.log(`[PRIVACY] executeScript - GPU vendor: ${body.gpu_vendor}, stripped device fingerprint`);

				// Forward sanitized request to Chinese server
				const chineseResponse = await fetch('https://landscape-api.vgabc.com/simulator/executeScript', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(sanitizedBody),
				});

				const responseData = await chineseResponse.json();

				// Return the Chinese server response as-is (direct CDN links)
				return new Response(JSON.stringify(responseData), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle /base/getBaseInfo endpoint
			if (url.pathname === '/base/getBaseInfo' && request.method === 'POST') {
				const baseInfoUrl = `${GITHUB_BASE}/base/getBaseInfo`;
				const response = await fetch(baseInfoUrl);

				if (!response.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch base info' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const data = await response.json();
				return new Response(JSON.stringify(data), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle /cloud/game/check_user_timer endpoint (important for Steam cloud sync)
			if (url.pathname === '/cloud/game/check_user_timer' && request.method === 'POST') {
				const timerUrl = `${GITHUB_BASE}/cloud/game/check_user_timer`;
				const response = await fetch(timerUrl);

				if (!response.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to check timer' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const data = await response.json();
				return new Response(JSON.stringify(data), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle /game/getDnsIpPool endpoint (DNS pool - empty to allow real Steam connections)
			if (url.pathname === '/game/getDnsIpPool' && request.method === 'POST') {
				const dnsPoolUrl = `${GITHUB_BASE}/game/getDnsIpPool`;
				const dnsPoolResponse = await fetch(dnsPoolUrl);

				if (!dnsPoolResponse.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch DNS pool' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const dnsPoolData = await dnsPoolResponse.json();

				return new Response(JSON.stringify(dnsPoolData), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle /game/getSteamHost endpoint (Steam CDN IPs)
			if (url.pathname === '/game/getSteamHost' && request.method === 'GET') {
				const hostsUrl = `${GITHUB_BASE}/game/getSteamHost/index`;
				const hostsResponse = await fetch(hostsUrl);

				if (!hostsResponse.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch Steam hosts' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const hostsText = await hostsResponse.text();

				return new Response(hostsText, {
					headers: { 'Content-Type': 'text/plain', ...corsHeaders },
				});
			}

			// Handle /card/getGameIcon endpoint (UI-related, return empty success)
			if (url.pathname === '/card/getGameIcon' && request.method === 'POST') {
				return new Response(JSON.stringify({
					code: 200,
					msg: "",
					time: Math.floor(Date.now() / 1000).toString(),
					data: []
				}), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Handle simulator/v2/getComponentList endpoint
			if (url.pathname === '/simulator/v2/getComponentList' && request.method === 'POST') {
				// Parse POST body
				const body = await request.json() as { type?: number; page?: number; page_size?: number };
				const type = body.type;
				const page = body.page || 1;
				const pageSize = body.page_size || 10;

				if (!type || !TYPE_TO_MANIFEST[type]) {
					return new Response(JSON.stringify({ code: 400, msg: 'Invalid type parameter' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				// Fetch the correct manifest from GitHub
				const manifestUrl = `${GITHUB_BASE}${TYPE_TO_MANIFEST[type]}`;
				const response = await fetch(manifestUrl);

				if (!response.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch manifest' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					});
				}

				const manifestData = await response.json();

				// Transform response: rename 'components' to 'list' if it exists
				if (manifestData.data && manifestData.data.components) {
					manifestData.data.list = manifestData.data.components;
					delete manifestData.data.components;
				}

				// Handle pagination
				if (manifestData.data && manifestData.data.list) {
					const allItems = manifestData.data.list;
					const total = manifestData.data.total || allItems.length;

					// Calculate pagination
					const startIndex = (page - 1) * pageSize;
					const endIndex = startIndex + pageSize;
					const paginatedItems = allItems.slice(startIndex, endIndex);

					// Update response with paginated data
					manifestData.data.list = paginatedItems;
					manifestData.data.page = page;
					manifestData.data.pageSize = pageSize;
					manifestData.data.total = total;
				}


				// Return the manifest data with direct CDN links
				return new Response(JSON.stringify(manifestData), {
					headers: { 'Content-Type': 'application/json', ...corsHeaders },
				});
			}

			// Proxy all other requests directly to GitHub
			const githubUrl = `${GITHUB_BASE}${url.pathname}`;
			const githubResponse = await fetch(githubUrl, {
				cf: {
					cacheTtl: 300, // Cache for 5 minutes
					cacheEverything: true,
				}
			});

			// Return GitHub response as-is with direct CDN links
			const responseBody = githubResponse.body;


			return new Response(responseBody, {
				status: githubResponse.status,
				headers: {
					...Object.fromEntries(githubResponse.headers),
					...corsHeaders,
					'Cache-Control': 'public, max-age=300', // 5 minutes
				},
			});
		} catch (error) {
			return new Response(JSON.stringify({ code: 500, msg: `Error: ${error.message}` }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}
	},
} satisfies ExportedHandler<Env>;
