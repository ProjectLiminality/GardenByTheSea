/**
 * PRISM Service Worker — Range-request proxy for WebTorrent streams.
 *
 * Browser video elements need HTTP range requests to play unfragmented MP4s
 * (they seek to the end to read the moov atom, then seek back to stream).
 * WebTorrent's renderTo/videostream can't handle this for large files.
 *
 * This service worker intercepts fetch requests to a virtual URL pattern
 * (/prism-stream/:id) and fulfills them using data posted from the main
 * page via MessageChannel. The main page reads from WebTorrent's file
 * using createReadStream and sends the bytes back through the channel.
 */

// Dynamic prefix based on SW scope — works at `/` (localhost) and `/PRISM/` (GitHub Pages)
const STREAM_PREFIX = new URL('prism-stream/', self.registration.scope).pathname;

// Active streams: id -> { fileSize, mimeType, port (MessagePort) }
const streams = new Map();

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'register-stream') {
    const { id, fileSize, mimeType } = e.data;
    const port = e.ports[0];
    streams.set(id, { fileSize, mimeType, port });
    console.log(`[PRISM SW] registered stream ${id} (${fileSize} bytes, ${mimeType})`);
  } else if (e.data && e.data.type === 'unregister-stream') {
    streams.delete(e.data.id);
    console.log(`[PRISM SW] unregistered stream ${e.data.id}`);
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only intercept /prism-stream/ requests — let everything else pass through
  if (!url.pathname.startsWith(STREAM_PREFIX)) return;

  const id = url.pathname.slice(STREAM_PREFIX.length);
  const stream = streams.get(id);

  if (!stream) {
    e.respondWith(new Response('Stream not found', { status: 404 }));
    return;
  }

  e.respondWith(handleStreamRequest(e.request, stream));
});

// Maximum chunk size served per request (2MB).
// The browser will make follow-up range requests for more data.
const MAX_CHUNK = 2 * 1024 * 1024;

async function handleStreamRequest(request, stream) {
  const { fileSize, mimeType, port } = stream;
  const range = request.headers.get('range');

  // No Range header = initial probe. Serve the first small chunk as a 200
  // with Accept-Ranges to signal that range requests are supported.
  // We MUST serve actual data (not empty body) because Safari expects
  // Content-Length to match the body size for 200 responses.
  if (!range) {
    console.log(`[PRISM SW] initial probe — serving first chunk with Accept-Ranges`);
    const end = Math.min(MAX_CHUNK - 1, fileSize - 1);
    const data = await requestData(port, 0, end);

    if (!data) {
      return new Response('Data not available yet', { status: 503 });
    }

    // Return 200 with full Content-Length but only partial data.
    // This tells the browser "there's more, use Range requests to get it."
    // Actually that's wrong — Content-Length must match body for 200.
    // Instead, return a 206 with Content-Range even without a Range header.
    // Browsers handle this correctly and will follow up with Range requests.
    return new Response(data, {
      status: 206,
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes 0-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end + 1),
        'Cache-Control': 'no-cache'
      }
    });
  }

  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    return new Response('Invalid range', { status: 416 });
  }

  const start = parseInt(match[1], 10);
  // Cap large ranges to MAX_CHUNK per response. Browsers often request the
  // full file (bytes=0-1712229168) but accept partial 206 responses and make
  // follow-up requests. Small precise ranges (like moov atom seeks near EOF)
  // are served as-is — they're typically just a few KB.
  const requestedEnd = match[2] ? parseInt(match[2], 10) : null;
  let end;
  if (requestedEnd !== null) {
    const requestedSize = requestedEnd - start + 1;
    if (requestedSize > MAX_CHUNK) {
      // Large range — cap it. Browser will follow up with more requests.
      end = Math.min(start + MAX_CHUNK - 1, fileSize - 1);
    } else {
      // Small precise range — serve it fully (e.g., moov atom seek)
      end = Math.min(requestedEnd, fileSize - 1);
    }
  } else {
    // Open-ended range (bytes=X-) — cap to MAX_CHUNK
    end = Math.min(start + MAX_CHUNK - 1, fileSize - 1);
  }

  if (start > end || start >= fileSize) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` }
    });
  }

  const chunkSize = end - start + 1;
  console.log(`[PRISM SW] range: bytes ${start}-${end} (${(chunkSize / 1024).toFixed(0)} KB)`);

  const data = await requestData(port, start, end);

  if (!data) {
    return new Response('Data not available yet', { status: 503 });
  }

  return new Response(data, {
    status: 206,
    headers: {
      'Content-Type': mimeType,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunkSize),
      'Cache-Control': 'no-cache'
    }
  });
}

function requestData(port, start, end) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      console.warn(`[PRISM SW] data request timed out (bytes ${start}-${end})`);
      resolve(null);
    }, 30000);

    channel.port1.onmessage = (e) => {
      clearTimeout(timeout);
      if (e.data && e.data.error) {
        console.error(`[PRISM SW] data error:`, e.data.error);
        resolve(null);
      } else {
        resolve(e.data.buffer);
      }
    };

    port.postMessage({ type: 'read', start, end, responsePort: true }, [channel.port2]);
  });
}
