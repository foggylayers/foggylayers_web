import fs from 'node:fs';
import path from 'node:path';

const listingId = process.env.LISTING_ID || '3259969450854035';
const outDir = process.env.OUT_DIR || 'fb_graphql';
fs.mkdirSync(outDir, { recursive: true });

const endpoint = 'https://www.facebook.com/api/graphql/';
const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.facebook.com',
  'Referer': `https://www.facebook.com/marketplace/item/${listingId}/`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function decodeGraphQL(text) {
  let body = text.trimStart();
  if (body.startsWith('for (;;);')) body = body.slice('for (;;);'.length);
  try { return JSON.parse(body); } catch (e) {
    const lines = body.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try { return JSON.parse(line); } catch (_) {}
    }
    throw e;
  }
}

async function graphql(docId, variables, label) {
  const form = new URLSearchParams({
    '__a': '1',
    '__comet_req': '15',
    'doc_id': docId,
    'variables': JSON.stringify(variables),
  });
  const res = await fetch(endpoint, { method: 'POST', headers, body: form, redirect: 'follow' });
  const text = await res.text();
  fs.writeFileSync(path.join(outDir, `${label}_raw.txt`), text);
  const data = decodeGraphQL(text);
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(data, null, 2));
  return { data, status: res.status, url: res.url };
}

const detailVariables = {
  feedbackSource: 56,
  feedLocation: 'MARKETPLACE_MEGAMALL',
  scale: 2,
  targetId: listingId,
  useDefaultActor: false,
  '__relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider': false,
  '__relay_internal__pv__CometUFISingleLineUFIrelayprovider': false,
  '__relay_internal__pv__CometUFIShareActionMigrationrelayprovider': true,
  '__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider': false,
  '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider': false,
  '__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider': false,
  '__relay_internal__pv__IsWorkUserrelayprovider': false,
  '__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider': false,
  '__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider': false,
  '__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider': false,
};

function getTarget(data) {
  return data?.data?.viewer?.marketplace_product_details_page?.target || null;
}

function collectUrls(value, at = '$', out = []) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push({ path: at, url: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectUrls(v, `${at}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => collectUrls(v, `${at}.${k}`, out));
  }
  return out;
}

function extFrom(contentType, url, fallback = '.bin') {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('jpeg')) return '.jpg';
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('mp4')) return '.mp4';
  if (ct.includes('quicktime')) return '.mov';
  const m = String(url).match(/\.(jpe?g|png|webp|gif|mp4|mov)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg','jpg')}` : fallback;
}

async function download(url, basename, index) {
  const res = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'], 'Referer': headers.Referer }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`response too small: ${buf.length}`);
  const ext = extFrom(res.headers.get('content-type'), url);
  const filename = `${basename}_${String(index).padStart(2, '0')}${ext}`;
  fs.writeFileSync(path.join(outDir, filename), buf);
  return { filename, bytes: buf.length, contentType: res.headers.get('content-type'), finalUrl: res.url };
}

const summary = { listingId, detail: null, images: null, listing: null, downloaded: [], urlInventory: [] };
try {
  const detail = await graphql('34344688261796183', detailVariables, 'detail');
  summary.detail = { status: detail.status, url: detail.url, errors: detail.data?.errors || [] };
  const target = getTarget(detail.data);
  if (target) {
    summary.listing = {
      id: target.id,
      title: target.marketplace_listing_title || target.base_marketplace_listing_title || '',
      price: target.listing_price || null,
      description: target.redacted_description?.text || '',
      location: target.location_text?.text || '',
      attributes: target.attribute_data || [],
      deliveryTypes: target.delivery_types || [],
      creationTime: target.creation_time || null,
      isPending: target.is_pending,
      isSold: target.is_sold,
      isLive: target.is_live,
      category: target.marketplaceListingRenderableIfLoggedOut?.marketplace_listing_category_name || '',
      sellerName: target.marketplace_listing_seller?.name || '',
    };
  }
  summary.urlInventory.push(...collectUrls(detail.data).map(x => ({ source: 'detail', ...x })));

  const images = await graphql('10059604367394414', { targetId: listingId }, 'images');
  summary.images = { status: images.status, url: images.url, errors: images.data?.errors || [] };
  const imageTarget = getTarget(images.data);
  const photos = imageTarget?.listing_photos || [];
  fs.writeFileSync(path.join(outDir, 'photos.json'), JSON.stringify(photos, null, 2));
  summary.urlInventory.push(...collectUrls(images.data).map(x => ({ source: 'images', ...x })));

  let photoIndex = 0;
  for (const photo of photos) {
    const url = photo?.image?.uri;
    if (!url) continue;
    try {
      summary.downloaded.push({ type: 'photo', sourcePath: 'listing_photos', ...(await download(url, 'photo', ++photoIndex)) });
    } catch (error) {
      summary.downloaded.push({ type: 'photo', sourcePath: 'listing_photos', error: String(error), url });
    }
  }

  const mediaCandidates = [];
  const seen = new Set();
  for (const item of summary.urlInventory) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const p = item.path.toLowerCase();
    const u = item.url.toLowerCase();
    if (/video|playable|browser_native_hd_url|browser_native_sd_url|dash|mp4/.test(p) || /\.mp4(?:\?|$)|video/.test(u)) {
      mediaCandidates.push(item);
    }
  }
  fs.writeFileSync(path.join(outDir, 'video_candidates.json'), JSON.stringify(mediaCandidates, null, 2));
  let videoIndex = 0;
  for (const item of mediaCandidates.slice(0, 20)) {
    try {
      const result = await download(item.url, 'video_candidate', ++videoIndex);
      summary.downloaded.push({ type: 'video-candidate', sourcePath: item.path, ...result });
    } catch (error) {
      summary.downloaded.push({ type: 'video-candidate', sourcePath: item.path, error: String(error), url: item.url });
    }
  }
} catch (error) {
  summary.fatalError = String(error?.stack || error);
  console.error(error);
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.fatalError) process.exitCode = 1;
