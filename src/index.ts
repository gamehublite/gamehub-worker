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

		// GLOBAL CACHE DISABLE - No caching anywhere
		const noCacheHeaders = {
			'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0, s-maxage=0',
			'Pragma': 'no-cache',
			'Expires': '0',
		};

		// Combine CORS + No-Cache headers for all responses
		const allHeaders = { ...corsHeaders, ...noCacheHeaders };

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: allHeaders });
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
				// Read token directly from KV (shared with token-refresher)
				// This avoids HTTP calls and reduces token-refresher load from 600k+ to ~0
				const tokenDataStr = await env.TOKEN_STORE.get('gamehub_token');

				let realToken: string;

				if (tokenDataStr) {
					const tokenData = JSON.parse(tokenDataStr);
					realToken = tokenData.token;
					console.log('[TOKEN] Using token from KV:', realToken);
				} else {
					// Fallback: HTTP fetch if KV is empty (shouldn't happen after first cron run)
					console.warn('[TOKEN] KV empty, falling back to HTTP fetch');
					const tokenResponse = await fetch(`${env.TOKEN_REFRESHER_URL}/token`, {
						headers: {
							'X-Worker-Auth': 'gamehub-internal-token-fetch-2025'
						}
					});

					if (tokenResponse.ok) {
						const tokenData = await tokenResponse.json();
						realToken = tokenData.token;
						console.log('[TOKEN] Fetched token via HTTP fallback:', realToken);
					} else {
						console.error('[TOKEN] Failed to fetch token (KV empty + HTTP failed)');
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

						bodyText = JSON.stringify(bodyJson);
						console.log('[TOKEN] Replaced fake-token and regenerated signature');

						modifiedRequest = new Request(request.url, {
							method: request.method,
							headers: newHeaders,
							body: bodyText,
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
					console.error('[TOKEN] Failed to get valid token');
				}
			}

			// Use modifiedRequest for all subsequent operations
			request = modifiedRequest;
			// ============================================================
			// API ENDPOINTS
			// ============================================================

			// Proxy /card/getGameDetail to Chinese server
			if (url.pathname === '/card/getGameDetail' && request.method === 'POST') {
				// Reuse bodyText if we already read it during token replacement
				if (!bodyText) {
					bodyText = await request.text();
				}

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
					headers: {
						'Content-Type': 'application/json',
						...allHeaders
					},
				});
			}

			// Handle /search/getGameList endpoint - Filter to show only Steam games
			if (url.pathname === '/search/getGameList' && request.method === 'POST') {
				// Reuse bodyText if we already read it during token replacement
				if (!bodyText) {
					bodyText = await request.text();
				}

				// Forward request to Chinese server with all original headers (for signature)
				const chineseResponse = await fetch('https://landscape-api.vgabc.com/search/getGameList', {
					method: 'POST',
					headers: request.headers,
					body: bodyText,
				});

				const responseData = await chineseResponse.json();

				// Filter to show only Steam games (steam_appid !== "0" and steam_appid exists)
				if (responseData.data && responseData.data.list) {
					const originalCount = responseData.data.list.length;

					// Keep only games with valid Steam app IDs
					responseData.data.list = responseData.data.list.filter(game => {
						return game.steam_appid && game.steam_appid !== "0" && game.steam_appid !== "";
					});

					const filteredCount = responseData.data.list.length;
					console.log(`[SEARCH] Filtered games: ${originalCount} -> ${filteredCount} (Steam only)`);

					// Update total counts to show only "All" tab with correct count
					if (responseData.data.total) {
						responseData.data.total = [
							{
								classify_group_id: 0,  // 0 = "All" tab
								count: filteredCount
							}
						];
					}

					// Update all_game_ids to match filtered list
					if (responseData.data.all_game_ids) {
						responseData.data.all_game_ids = responseData.data.list.map(game => ({
							steam_app_id: game.steam_appid,
							game_id: game.id
						}));
					}
				}

				// Return the filtered response
				return new Response(JSON.stringify(responseData), {
					headers: { 'Content-Type': 'application/json', ...allHeaders },
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
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				const newsData = await newsResponse.json();
				return new Response(JSON.stringify(newsData), {
					headers: { 'Content-Type': 'application/json', ...allHeaders },
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
						headers: { 'Content-Type': 'application/json', ...allHeaders },
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
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				const newsDetailData = await newsDetailResponse.json();
				return new Response(JSON.stringify(newsDetailData), {
					headers: { 'Content-Type': 'application/json', ...allHeaders },
				});
			}

			// Handle /card/getIndexList endpoint - Serve free games from KV storage
			if (url.pathname === '/card/getIndexList' && request.method === 'POST') {
				console.log('[FREE_GAMES] Reading free games from KV storage');

				try {
					// Read directly from KV (same storage as Free Games Worker)
					const cachedData = await env.FREE_GAMES_KV.get('free_games_data');

					if (!cachedData) {
						console.log('[FREE_GAMES] No data in KV storage');
						return new Response(JSON.stringify({
							code: 201,
							msg: 'No free games available at the moment, please try again later',
							data: [],
							time: Math.floor(Date.now() / 1000).toString()
						}), {
							headers: { 'Content-Type': 'application/json', ...allHeaders },
						});
					}

					console.log('[FREE_GAMES] Successfully read free games from KV');

					// Parse the data and limit card_list to display_card_num
					const freeGamesData = JSON.parse(cachedData);

					// Slice each topic's card_list to display_card_num (initially show 6 items max)
					freeGamesData.data = freeGamesData.data.map(topic => ({
						...topic,
						card_list: topic.card_list.slice(0, topic.display_card_num)
					}));

					return new Response(JSON.stringify(freeGamesData), {
						headers: {
							'Content-Type': 'application/json',
							...allHeaders // NO CACHE
						},
					});
				} catch (error) {
					console.error('[FREE_GAMES] Error reading from KV:', error);
					return new Response(JSON.stringify({
						code: 500,
						msg: 'Internal server error',
						data: [],
						time: Math.floor(Date.now() / 1000).toString()
					}), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}
			}

			// Handle /card/more endpoint - Get all items for a specific topic
			if (url.pathname === '/card/more' && request.method === 'POST') {
				console.log('[FREE_GAMES_MORE] Getting more items for topic');

				try {
					const body = await request.json();
					const topicId = body.id;
					const page = body.page || 1;
					const pageSize = body.page_size || 30;

					if (!topicId) {
						return new Response(JSON.stringify({
							code: 400,
							msg: 'Missing topic ID',
							time: Math.floor(Date.now() / 1000).toString(),
							data: null
						}), {
							status: 400,
							headers: { 'Content-Type': 'application/json', ...allHeaders },
						});
					}

					// Read free games data from KV
					const cachedData = await env.FREE_GAMES_KV.get('free_games_data');

					if (!cachedData) {
						return new Response(JSON.stringify({
							code: 201,
							msg: 'No data available',
							time: Math.floor(Date.now() / 1000).toString(),
							data: null
						}), {
							headers: { 'Content-Type': 'application/json', ...allHeaders },
						});
					}

					const freeGamesData = JSON.parse(cachedData);
					const topic = freeGamesData.data.find(t => t.id === topicId);

					if (!topic) {
						return new Response(JSON.stringify({
							code: 404,
							msg: 'Topic not found',
							time: Math.floor(Date.now() / 1000).toString(),
							data: null
						}), {
							status: 404,
							headers: { 'Content-Type': 'application/json', ...allHeaders },
						});
					}

					// Return all cards for this topic (pagination handled by app)
					const startIndex = (page - 1) * pageSize;
					const endIndex = startIndex + pageSize;
					const paginatedCards = topic.card_list.slice(startIndex, endIndex);

					return new Response(JSON.stringify({
						code: 0,
						msg: '',
						time: Math.floor(Date.now() / 1000).toString(),
						data: {
							id: topic.id,
							title: topic.title,
							aspect_ratio: topic.aspect_ratio,
							fixed_card_size: topic.fixed_card_size,
							is_play_video: topic.is_play_video,
							page: page,
							page_size: pageSize,
							is_vertical: topic.is_vertical,
							is_text_outside: topic.is_text_outside,
							card_list: paginatedCards
						}
					}), {
						headers: {
							'Content-Type': 'application/json',
							...allHeaders // NO CACHE
						},
					});
				} catch (error) {
					console.error('[FREE_GAMES_MORE] Error:', error);
					return new Response(JSON.stringify({
						code: 500,
						msg: 'Internal server error',
						time: Math.floor(Date.now() / 1000).toString(),
						data: null
					}), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}
			}

			// Proxy /simulator/executeScript to Chinese server (NO sanitization)
			if (url.pathname === '/simulator/executeScript' && request.method === 'POST') {
				// Reuse bodyText if we already read it during token replacement
				if (!bodyText) {
					bodyText = await request.text();
				}

				// Forward request AS-IS to Chinese server with all original headers
				const chineseResponse = await fetch('https://landscape-api.vgabc.com/simulator/executeScript', {
					method: 'POST',
					headers: request.headers,
					body: bodyText,
				});

				const responseData = await chineseResponse.json();

				// Return the Chinese server response as-is (no cache)
				return new Response(JSON.stringify(responseData), {
					headers: {
						'Content-Type': 'application/json',
						...allHeaders
					},
				});
			}

			// Handle /base/getBaseInfo endpoint
			if (url.pathname === '/base/getBaseInfo' && request.method === 'POST') {
				const baseInfoUrl = `${GITHUB_BASE}/base/getBaseInfo`;
				const response = await fetch(baseInfoUrl);

				if (!response.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch base info' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				const data = await response.json();
				return new Response(JSON.stringify(data), {
					headers: { 'Content-Type': 'application/json', ...allHeaders },
				});
			}

			// Handle /cloud/game/check_user_timer endpoint (important for Steam cloud sync)
			if (url.pathname === '/cloud/game/check_user_timer' && request.method === 'POST') {
				const timerUrl = `${GITHUB_BASE}/cloud/game/check_user_timer`;
				const response = await fetch(timerUrl);

				if (!response.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to check timer' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				const data = await response.json();
				return new Response(JSON.stringify(data), {
					headers: { 'Content-Type': 'application/json', ...allHeaders },
				});
			}

			// Handle /game/getDnsIpPool endpoint (DNS pool - empty to allow real Steam connections)
			if (url.pathname === '/game/getDnsIpPool' && request.method === 'POST') {
				const dnsPoolUrl = `${GITHUB_BASE}/game/getDnsIpPool`;
				const dnsPoolResponse = await fetch(dnsPoolUrl);

				if (!dnsPoolResponse.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch DNS pool' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				const dnsPoolData = await dnsPoolResponse.json();

				return new Response(JSON.stringify(dnsPoolData), {
					headers: { 'Content-Type': 'application/json', ...allHeaders },
				});
			}

			// Handle /game/getSteamHost endpoint (Steam CDN IPs)
			if (url.pathname === '/game/getSteamHost' && request.method === 'GET') {
				const hostsUrl = `${GITHUB_BASE}/game/getSteamHost/index`;
				const hostsResponse = await fetch(hostsUrl);

				if (!hostsResponse.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch Steam hosts' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				const hostsText = await hostsResponse.text();

				return new Response(hostsText, {
					headers: { 'Content-Type': 'text/plain', ...allHeaders },
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
					headers: { 'Content-Type': 'application/json', ...allHeaders },
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
						headers: { 'Content-Type': 'application/json', ...allHeaders },
					});
				}

				// Fetch the correct manifest from GitHub
				const manifestUrl = `${GITHUB_BASE}${TYPE_TO_MANIFEST[type]}`;
				const response = await fetch(manifestUrl);

				if (!response.ok) {
					return new Response(JSON.stringify({ code: 500, msg: 'Failed to fetch manifest' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json', ...allHeaders },
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
					headers: { 'Content-Type': 'application/json', ...allHeaders },
				});
			}

			// Proxy all other requests directly to GitHub (NO CACHE)
			const githubUrl = `${GITHUB_BASE}${url.pathname}`;
			const githubResponse = await fetch(githubUrl, {
				cf: {
					cacheTtl: 0, // NO CACHE
					cacheEverything: false,
				}
			});

			// Return GitHub response as-is with direct CDN links
			const responseBody = githubResponse.body;


			return new Response(responseBody, {
				status: githubResponse.status,
				headers: {
					...Object.fromEntries(githubResponse.headers),
					...allHeaders, // NO CACHE - overrides any GitHub cache headers
				},
			});
		} catch (error) {
			return new Response(JSON.stringify({ code: 500, msg: `Error: ${error.message}` }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...allHeaders },
			});
		}
	},
} satisfies ExportedHandler<Env>;
