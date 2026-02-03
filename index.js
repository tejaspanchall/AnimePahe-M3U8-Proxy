import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import nodeFetch from 'node-fetch';


const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// Internal Cookie Jar to maintain session across M3U8 -> KEY -> SEGMENT requests
const cookieJar = new Map();

app.listen(PORT, () => {
    console.log("Server Listening on PORT:", PORT);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
});

app.get("/m3u8-proxy", async (req, res) => {
    let responseSent = false;
    const safeSendResponse = (statusCode, data) => {
        try {
            if (!responseSent) {
                responseSent = true;
                res.status(statusCode).send(data);
            }
        } catch (err) { }
    };

    try {
        const urlStr = req.query.url;
        if (!urlStr) return safeSendResponse(400, { message: "URL is required" });

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        let directReferer = req.query.referer || req.query.referrer;

        // Modern User-Agent
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

        const headers = {
            "User-Agent": userAgent,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
        };

        // Forward critical headers from client
        const forwardHeaders = ['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'authorization', 'cookie'];
        forwardHeaders.forEach(h => {
            if (req.headers[h]) headers[h] = req.headers[h];
        });

        // Apply headersParam
        if (headersParam) {
            try {
                const additionalHeaders = JSON.parse(headersParam);
                Object.entries(additionalHeaders).forEach(([key, value]) => {
                    const lowerKey = key.toLowerCase();
                    headers[lowerKey] = value;
                    if (lowerKey === 'referer' || lowerKey === 'referrer') {
                        directReferer = value;
                    }
                });
            } catch (e) { }
        }

        // Handle Referer and Origin parity with trailing slash protection
        if (directReferer) {
            let refStr = decodeURIComponent(directReferer);
            if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) {
                refStr += '/';
            }
            headers['referer'] = refStr;
        }
        if (headers['referer']) {
            try {
                const refUrl = new URL(headers['referer']);
                headers['origin'] = refUrl.origin;
            } catch (e) {
                headers['origin'] = headers['referer'];
            }
        }

        // Security Fallback: Avoid localhost
        if (!headers['origin'] || headers['origin'].includes('localhost')) {
            headers['origin'] = url.origin;
        }
        if (!headers['referer']) {
            headers['referer'] = url.origin;
        }

        // INJECT COOKIES FROM INTERNAL JAR
        const storedCookies = cookieJar.get(url.hostname);
        if (storedCookies) {
            if (headers['cookie']) {
                headers['cookie'] = `${headers['cookie']}; ${storedCookies}`;
            } else {
                headers['cookie'] = storedCookies;
            }
        }

        if (url.pathname.endsWith(".mp4")) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
        }

        const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8");
        const isKey = url.pathname.toLowerCase().includes('.key');

        console.log(`[m3u8-proxy] Proxying: ${url.href}`);

        const targetResponse = await nodeFetch(url.href, {
            headers,
            redirect: 'follow',
            compress: false
        });

        // CAPTURE COOKIES INTO INTERNAL JAR
        const setCookieHeaders = targetResponse.headers.raw()['set-cookie'];
        if (setCookieHeaders) {
            // Merge cookies for this domain
            const currentCookies = cookieJar.get(url.hostname) || "";
            const newCookies = setCookieHeaders.map(c => c.split(';')[0]).join('; ');
            cookieJar.set(url.hostname, currentCookies ? `${currentCookies}; ${newCookies}` : newCookies);
            console.log(`[m3u8-proxy] Cookie Jar Update for ${url.hostname}`);
        }

        // CORS Setup with Credential Support
        const requestOrigin = req.headers.origin || '*';
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Range, Authorization, Cookie');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Proxy-By', 'm3u8-proxy');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        if (isPlaylist || targetResponse.headers.get('content-type')?.includes("mpegURL")) {
            console.log(`[m3u8-proxy] Playlist: ${targetResponse.status}`);
            let modifiedM3u8 = await targetResponse.text();

            modifiedM3u8 = modifiedM3u8.split("\n").map((line) => {
                const trimmedLine = line.trim();
                // Don't proxy certain tags or empty lines
                if (trimmedLine === '' || trimmedLine.startsWith("#EXTM3U") || trimmedLine.startsWith("#EXT-X-VERSION")) return line;

                // Proxy tags with URIs (KEY, MAP, MEDIA, etc)
                if (trimmedLine.startsWith("#")) {
                    return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, p1, suffix) => {
                        try {
                            const absoluteUrl = new URL(p1, url.href).href;
                            let newUri = `/m3u8-proxy?url=${encodeURIComponent(absoluteUrl)}`;
                            if (headersParam) newUri += `&headers=${encodeURIComponent(headersParam)}`;
                            if (directReferer) newUri += `&referer=${encodeURIComponent(directReferer)}`;
                            return `${prefix}${newUri}${suffix}`;
                        } catch (e) { return match; }
                    });
                }

                // Proxy actual segment or variant URLs
                try {
                    // Check if it's already a full URL or a relative path
                    const absoluteUrl = new URL(trimmedLine, url.href).href;
                    let newUrl = `/m3u8-proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    if (headersParam) newUrl += `&headers=${encodeURIComponent(headersParam)}`;
                    if (directReferer) newUrl += `&referer=${encodeURIComponent(directReferer)}`;
                    return newUrl;
                } catch (e) { return line; }
            }).join("\n");

            res.setHeader('Content-Type', targetResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
            res.status(200).send(modifiedM3u8);
        } else {
            let contentType = targetResponse.headers.get('content-type') || "";
            const contentLength = targetResponse.headers.get('content-length');

            // Force correct MIME types for obfuscated or binary files
            const lowerPath = url.pathname.toLowerCase();
            if (lowerPath.includes('segment') || lowerPath.endsWith('.jpg') || lowerPath.endsWith('.ts')) {
                contentType = "video/mp2t";
            } else if (isKey || lowerPath.endsWith('.key')) {
                contentType = "application/octet-stream";
            }

            console.log(`[m3u8-proxy] Stream: ${targetResponse.status} [${contentType}] [${contentLength} bytes]`);

            targetResponse.headers.forEach((value, key) => {
                const lowerKey = key.toLowerCase();
                const preservedHeaders = [
                    'content-length', 'content-range', 'accept-ranges',
                    'last-modified', 'etag', 'vary'
                ];
                if (preservedHeaders.includes(lowerKey)) {
                    res.setHeader(key, value);
                }
            });

            res.setHeader('Content-Type', contentType);
            res.writeHead(targetResponse.status);

            if (targetResponse.body) {
                targetResponse.body.pipe(res);
            } else {
                res.end();
            }
        }
    } catch (e) {
        console.error('[m3u8-proxy] Error:', e.message);
        if (!res.headersSent) safeSendResponse(500, { message: e.message });
    }
});
