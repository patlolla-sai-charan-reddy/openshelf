#!/usr/bin/env node
// Daily collector. Builds data/*.json from REAL, public retailer endpoints so every product has a correct image, price and
// canonical product URL. Runs every morning in .github/workflows/feed.yml (then build-feed.mjs validates, refreshes agents.json,
// index.html and the discovery files, and the workflow commits → the static host redeploys).
//   • Shopify stores' public /products.json (Everlane, Glossier, Casper, Manduka, Kith, …)
//   • Retailer product pages' og:image + og/product price meta (Nike, Puma, Converse, IKEA, KitchenAid, Garmin, Samsung, …)
// Every image URL is verified (browser UA, content-type image/*), then everything runs through validate.js.
// Usage: node scripts/build-catalog.mjs [--dry-run]   (env COLLECT_TOP=n overrides how many extra products per T() entry)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { validateProducts } = createRequire(import.meta.url)(join(ROOT, 'validate.js'));
const DRY = process.argv.includes('--dry-run');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const get = async (u, accept = 'text/html', ms = 15000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await fetch(u, { signal: c.signal, redirect: 'follow', headers: { 'user-agent': UA, accept } }); } finally { clearTimeout(t); } };
// Ask each CDN for a square 352×352 (2× of the 176px cell) so <img width=176 height=176> never distorts.
function squarify(u) {
  const h = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
  if (/cdn\.shopify\.com|\/cdn\/shop\//.test(u)) return u.replace(/[?&](width|height|crop)=[^&]*/g, '').replace(/\?&/, '?').replace(/[?&]?$/, m => (u.includes('?') ? '&' : '?')) + 'width=352&height=352&crop=center';
  if (/scene7\.com|s7-img-facade|madewell\.com\/images/.test(u)) return u.split('?')[0] + '?wid=352&hei=352&fit=fit,1&bgc=255,255,255&fmt=jpeg';
  if (/\/dw\/image\/v2\//.test(u)) return u.split('?')[0] + '?sw=352&sh=352&sm=cut';
  if (h === 'static.nike.com') return u.replace(/\/t_[^/]+\//, '/t_default,w_352,h_352,c_pad,b_white/');
  if (h === 'images.puma.com') return u.replace(/w_\d+,h_\d+/, 'w_352,h_352');
  if (h.endsWith('converse.com')) return u.split('?')[0] + '?sw=352&sh=352&sm=cut';
  if (h.endsWith('datocms-assets.com')) return u.split('?')[0] + '?w=352&h=352&fit=crop';
  if (h.endsWith('ctfassets.net')) return u.split('?')[0] + '?w=352&h=352&fit=pad&bg=rgb:ffffff';
  if (h.endsWith('vtexassets.com')) return u.replace(/\/ids\/(\d+)(-\d+-\d+)?\//, '/ids/$1-352-352/');
  return u;
}
// Read pixel dimensions from the image bytes (PNG/JPEG/GIF/WebP) so we can flag non-square photos.
function dims(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0x89 && b[1] === 0x50) return [(b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0];
  if (b[0] === 0x47 && b[1] === 0x49) return [b[6] | b[7] << 8, b[8] | b[9] << 8];
  if (b[0] === 0x52 && b[8] === 0x57) { const t = String.fromCharCode(b[12], b[13], b[14], b[15]); if (t === 'VP8 ') return [(b[26] | b[27] << 8) & 0x3fff, (b[28] | b[29] << 8) & 0x3fff]; if (t === 'VP8L') return [1 + ((b[21] | (b[22] & 0x3f) << 8)), 1 + (((b[22] >> 6) | b[23] << 2 | (b[24] & 0x0f) << 10))]; if (t === 'VP8X') return [1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)]; }
  if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i < b.length - 9) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b[i + 7] << 8 | b[i + 8], b[i + 5] << 8 | b[i + 6]]; i += 2 + (b[i + 2] << 8 | b[i + 3]); } }
  return null;
}
const isImage = async u => { try { const r = await get(u, 'image/*'); if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return false; const d = dims(await r.arrayBuffer()); if (d && Math.abs(d[0] / d[1] - 1) > 0.15) console.warn(`    ! not square (${d[0]}×${d[1]}): ${u.slice(0, 90)}`); return true; } catch { return false; } };
const words = s => [...new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))];
const clean = s => String(s).replace(/®|™|©/g, '').replace(/\s*[|–—-]\s*(Last Call|Best Sellers?)$/i, '').replace(/\s+/g, ' ').trim();
const tidyTitle = (t, brand) => {
  t = clean(t).replace(new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), '');
  for (let m; (m = t.match(/^(.{3,}?)\s*[|–—-]\s*[^|–—\d-]*$/));) t = m[1].trim();   // drop " | Navy", " - Black / White", " | Standard" suffixes
  if (t.length >= 12 && t === t.toUpperCase() && /[A-Z]{3}/.test(t)) t = t.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Trx|Skims|Oz)\b/g, w => w.toUpperCase());
  return t;
};

// ---------- Curated spec ----------
// S(store, category, picks[], opts) → Shopify. Each pick is a handle string, or a RegExp matched against the title (first available, non-bundle match).
// O(url, category, brand, title, fallbackPrice, keywords) → og:image page.
const S = (host, merchant, category, picks, o = {}) => ({ kind: 'shopify', host, merchant, category, picks, ...o });
const O = (url, category, merchant, brand, title, price, kw = '') => ({ kind: 'og', url, category, merchant, brand, title, price, kw });
// T(store, merchant, category, match, take) → Shopify: collect up to `take` available products whose product_type or title matches (newest first).
const TOP = +(process.env.COLLECT_TOP || 4);
const T = (host, merchant, category, match, take = TOP, o = {}) => ({ kind: 'shopify-top', host, merchant, category, match, take, ...o });
const SPEC = [
  // shoes
  O('https://www.nike.com/t/air-force-1-07-mens-shoes-jBrhbr', 'shoes', 'Nike', 'Nike', "Air Force 1 '07", 115, 'sneakers white leather classic'),
  O('https://us.puma.com/us/en/pd/suede-classic-xxi-sneakers/374915', 'shoes', 'Puma', 'Puma', 'Suede Classic XXI', 75, 'sneakers suede retro'),
  O('https://www.converse.com/shop/p/chuck-taylor-all-star-unisex-high-top-shoe/M9160.html', 'shoes', 'Converse', 'Converse', 'Chuck Taylor All Star High Top', 65, 'sneakers canvas high top'),
  S('kith.com', 'Kith', 'shoes', [/^Nike Air Max 90/, /^New Balance (990|2002|550|1906|574|1890)/, /^ASICS (?!.*\b(PS|TD|GS)\b)/i, /^Salomon/, /^Jordan Air Jordan \d/, /^adidas (?!.*\b(PS|TD|GS|Disney)\b).*(Samba|Gazelle|Superstar|Campus)/i, /^Nike (Dunk|Air Max 1|Air Max 95|Cortez|Blazer)(?!.*\b(PS|TD|GS)\b)/], { kw: 'sneakers' }),
  S('www.allbirds.com', 'Allbirds', 'shoes', ['mens-tree-runners-mist', 'womens-tree-dashers'], { kw: 'sneakers running sustainable' }),
  S('www.rothys.com', "Rothy's", 'shoes', ['womens-pointed-toe-flat-tan-woven'], { kw: 'flats women' }),
  // clothing
  S('www.everlane.com', 'Everlane', 'clothing', ['mens-relaxed-heavyweight-tee-white', 'womens-way-high-sailor-jean-2-washed-out-indigo', 'womens-organic-cotton-field-jacket-cornstalk', /^The Slim Oxford Shirt \|(?!.*Tall)/]),
  O('https://www.madewell.com/the-perfect-vintage-jean-in-fitzgerald-wash-MC948.html', 'clothing', 'Madewell', 'Madewell', 'The Perfect Vintage Jean', 128, 'jeans denim women'),
  S('www.skims.com', 'SKIMS', 'clothing', ['cotton-fleece-classic-hoodie-navy', 'soft-lounge-long-slip-dress-sleet'], { brand: 'SKIMS' }),
  S('www.outdoorvoices.com', 'Outdoor Voices', 'clothing', ['w-the-volley-dress-sea-green', /Legging/]),
  S('kith.com', 'Kith', 'clothing', [/^Kith .*(Hoodie|Crewneck)/, /^Kith .*Tee/], { brand: 'Kith', vendor: 'Kith', kw: 'streetwear' }),
  // electronics
  O('https://www.garmin.com/en-US/p/780139', 'electronics', 'Garmin', 'Garmin', 'Forerunner 265 GPS Watch', 449.99, 'gps watch running smartwatch fitness'),
  S('www.skullcandy.com', 'Skullcandy', 'electronics', [/^Crusher.*ANC/, /^Dime/], { brand: 'Skullcandy', kw: 'headphones earbuds wireless' }),
  S('www.masterdynamic.com', 'Master & Dynamic', 'electronics', [/^MH40 Wired/, /^MW09/], { brand: 'Master & Dynamic', kw: 'headphones wireless premium' }),
  S('www.jlab.com', 'JLab', 'electronics', [/^JBuds Lux ANC/, /^GO POP\b/i], { brand: 'JLab', kw: 'earbuds headphones wireless budget' }),
  S('www.mophie.com', 'mophie', 'electronics', [/Powerstation Plus 10K/, /3-in-1 Wireless Charge Stand/], { brand: 'mophie', kw: 'power bank charger battery' }),
  S('www.keychron.com', 'Keychron', 'electronics', [/^Keychron (K2|K8|V1|Q1) /], { brand: 'Keychron', kw: 'keyboard mechanical wireless' }),
  S('www.satechi.net', 'Satechi', 'electronics', [/Wireless Mouse/, /Multiport Adapter/], { brand: 'Satechi', kw: 'mouse hub usb-c accessory' }),
  S('www.wyze.com', 'Wyze', 'electronics', [/^Wyze Cam v4$/, /^Wyze Cam OG$/], { brand: 'Wyze', kw: 'security camera smart home' }),
  S('shop.boox.com', 'BOOX', 'electronics', [/^BOOX Go 6/], { brand: 'BOOX', kw: 'ereader e-ink tablet reading' }),
  S('shop.8bitdo.com', '8BitDo', 'electronics', [/Ultimate 2 Wireless Controller/], { brand: '8BitDo', kw: 'controller gaming' }),
  S('www.twelvesouth.com', 'Twelve South', 'electronics', [/^AirFly Pro/, /^HiRise 3/], { brand: 'Twelve South', kw: 'accessory charger bluetooth' }),
  // home
  S('www.brooklinen.com', 'Brooklinen', 'home', [/^Classic Percale Core Sheet Set$/, /^Luxe Sateen Core Sheet Set$/, /^Super-Plush.*Bath Towels/], { kw: 'bedding sheets towels' }),
  S('casper.com', 'Casper', 'home', ['original-foam-v1', 'original-cooling-pillow'], { kw: 'mattress pillow bedroom sleep' }),
  S('www.parachutehome.com', 'Parachute', 'home', [/^Percale Sheet Set - .* F\/Q$/, /Robe/], { brand: 'Parachute', kw: 'bedding sheets bath' }),
  O('https://www.ikea.com/us/en/p/kallax-shelf-unit-white-80275887/', 'home', 'IKEA', 'IKEA', 'KALLAX Shelf Unit 2x4', 89.99, 'shelf storage furniture bookcase'),
  O('https://www.kitchenaid.com/countertop-appliances/stand-mixers/tilt-head-stand-mixers/p.artisan-series-5-quart-tilt-head-stand-mixer.ksm150pser.html', 'home', 'KitchenAid', 'KitchenAid', 'Artisan Series 5qt Stand Mixer', 449.99, 'stand mixer baking kitchen appliance'),
  O('https://www.williams-sonoma.com/products/le-creuset-signature-round-dutch-oven/', 'home', 'Williams Sonoma', 'Le Creuset', 'Signature Round Dutch Oven', 419.95, 'dutch oven cookware pot cast iron kitchen'),
  O('https://ruggable.com/products/kamran-hazel-rug', 'home', 'Ruggable', 'Ruggable', 'Kamran Hazel Washable Rug', 219, 'rug washable living room decor'),
  S('www.lifx.com', 'LIFX', 'home', [/^LIFX .*(Bulb|A19)/i, /SuperColor 13" Ceiling White/], { brand: 'LIFX', kw: 'smart light bulb lighting' }),
  S('www.stanley1913.com', 'Stanley', 'home', [/^The Everyday Tumbler \| 20 OZ/], { brand: 'Stanley', kw: 'tumbler drinkware kitchen' }),
  // beauty
  S('www.glossier.com', 'Glossier', 'beauty', ['boy-brow', 'balm-dotcom', 'cloud-paint', 'milky-jelly-cleansing-balm', 'futuredew-solid'], { kw: 'makeup skincare' }),
  S('www.rarebeauty.com', 'Rare Beauty', 'beauty', [/^Soft Pinch Liquid Blush$/, /^Soft Pinch Liquid Blush(?! Duo)/, 'positive-light-luminizing-lip-gloss', 'find-comfort-lip-butter'], { kw: 'makeup' }),
  S('www.fentybeauty.com', 'Fenty Beauty', 'beauty', ['gloss-bomb-universal-lip-luminizer-diamond-milk', 'sun-stalkr-instant-warmth-bronzer-chai-latte'], { kw: 'makeup lips bronzer' }),
  S('www.colourpop.com', 'ColourPop', 'beauty', ['baby-got-blush'], { kw: 'makeup palette blush' }),
  O('https://www.paulaschoice.com/skin-perfecting-2pct-bha-liquid-exfoliant/201.html', 'beauty', "Paula's Choice", "Paula's Choice", 'Skin Perfecting 2% BHA Liquid Exfoliant', 35, 'exfoliant skincare toner acne'),
  O('https://theordinary.com/en-us/niacinamide-10-zinc-1-serum-100436.html', 'beauty', 'The Ordinary', 'The Ordinary', 'Niacinamide 10% + Zinc 1%', 6.5, 'serum skincare pores'),
  // sports
  S('www.manduka.com', 'Manduka', 'sports', ['manduka-pro-yoga-mat', 'cork-yoga-block'], { kw: 'yoga fitness pilates' }),
  S('www.therabody.com', 'Therabody', 'sports', ['theragun-prime-gen-6-massage-gun', 'theragun-relief-charcoal'], { brand: 'Therabody', kw: 'massage gun recovery percussion' }),
  S('www.trxtraining.com', 'TRX', 'sports', ['trx-home2-system-best-sellers'], { brand: 'TRX', kw: 'suspension trainer home gym bodyweight' }),
  S('www.stanley1913.com', 'Stanley', 'sports', ['quencher-h2-0-flowstate-tumbler-40-oz-1-18-l-bts', 'iceflow-bottle-flip-straw-2-0-24-oz-stanley-create'], { brand: 'Stanley', kw: 'water bottle tumbler hydration insulated' }),
  O('https://www.onepeloton.com/shop/bike', 'sports', 'Peloton', 'Peloton', 'Bike', 1445, 'exercise bike indoor cycling cardio'),
  S('www.outdoorvoices.com', 'Outdoor Voices', 'sports', ['w-jog-6-short-black', /^Zephyr 3" Short/, /^GridTek Breezy Shortsleeve/], { kw: 'running shorts activewear workout' }),
  S('www.wyze.com', 'Wyze', 'sports', [/^Wyze Scale/], { brand: 'Wyze', kw: 'smart scale fitness weight' }),
  S('www.allbirds.com', 'Allbirds', 'sports', ['womens-tree-dasher-relay'], { kw: 'running shoes trainers' }),
  // collectors: fresh/new products per store, on top of the curated picks (dedupe by url happens in validate.js)
  T('kith.com', 'Kith', 'shoes', /Sneakers/, TOP, { exclude: /\b(PS|TD|GS|Infant)\b/ }),
  T('www.allbirds.com', 'Allbirds', 'shoes', /^Shoes$/),
  T('www.everlane.com', 'Everlane', 'clothing', /Knit Tops|Denim|Shirting|Outerwear/),
  T('www.outdoorvoices.com', 'Outdoor Voices', 'clothing', /Dresses|Leggings/),
  T('www.skullcandy.com', 'Skullcandy', 'electronics', /Headphones|Earbuds/i, TOP, { brand: 'Skullcandy' }),
  T('www.keychron.com', 'Keychron', 'electronics', /Keyboard/i, TOP, { brand: 'Keychron', match2: /Keyboard/ }),
  T('www.wyze.com', 'Wyze', 'electronics', /Cam/i, TOP, { brand: 'Wyze' }),
  T('www.brooklinen.com', 'Brooklinen', 'home', /Sheets|Duvet Covers|Towels/),
  T('www.parachutehome.com', 'Parachute', 'home', /Sheets|Towels|Bathrobes/, TOP, { brand: 'Parachute' }),
  T('www.glossier.com', 'Glossier', 'beauty', /Makeup|Skincare|Balms/),
  T('www.rarebeauty.com', 'Rare Beauty', 'beauty', /Blush|Lip/i),
  T('www.fentybeauty.com', 'Fenty Beauty', 'beauty', /Lip Gloss|Blushes/),
  T('www.manduka.com', 'Manduka', 'sports', /Mats|Props/),
  T('www.therabody.com', 'Therabody', 'sports', /^Theragun$/, TOP, { brand: 'Therabody' }),
  T('www.stanley1913.com', 'Stanley', 'sports', /Tumblers|Bottles/i, TOP, { brand: 'Stanley' }),
  T('www.melissaanddoug.com', 'Melissa & Doug', 'kids', /Puzzles|Blocks|Play/),
  T('www.radioflyer.com', 'Radio Flyer', 'kids', /Ride-On|Wagon|Tricycle/i),
  T('www.playosmo.com', 'Osmo', 'kids', /./, TOP, { brand: 'Osmo' }),
  // kids
  S('www.melissaanddoug.com', 'Melissa & Doug', 'kids', ['ms-rachel-bubble-bubble-pop-sort-stack-count-nesting-blocks', 'dinosaur-adventure-track-floor-puzzle', 'ms-rachel-alphabet-phonics-puzzle', /Doctor/], { kw: 'toys toddler learning wooden' }),
  S('www.radioflyer.com', 'Radio Flyer', 'kids', ['scoot-2-scooter-1', 'push-pull-walker-wagon-teddy-bear', /Classic Red Wagon/, /My 1st Balance Bike/], { kw: 'toys ride on outdoor wagon' }),
  S('www.playosmo.com', 'Osmo', 'kids', ['genius-starter-kit', 'little-genius-starter-kit', 'coding-starter-kit'], { brand: 'Osmo', kw: 'educational learning games stem ipad' }),
  S('www.striderite.com', 'Stride Rite', 'kids', ['ames-sneaker-littlekid-navy', 'jazz-hook-loop-sneaker-bigkid-white-grey-red'], { kw: 'kids shoes sneakers toddler' }),
  O('https://www.hatch.co/rest', 'kids', 'Hatch', 'Hatch', 'Rest 2nd Gen Sound Machine', 69.99, 'sound machine night light baby sleep'),
  S('www.allbirds.com', 'Allbirds', 'kids', [/^Smallbirds/], { kw: 'kids shoes toddler' }),
];

// ---------- Fetchers ----------
const shopifyCache = {};
async function shopifyList(host) {
  if (shopifyCache[host]) return shopifyCache[host];
  const all = [];
  for (let page = 1; page <= 4; page++) {
    const r = await get(`https://${host}/products.json?limit=250&page=${page}`, 'application/json');
    if (!r.ok) break;
    const j = await r.json(); if (!j.products?.length) break;
    all.push(...j.products); if (j.products.length < 250) break;
  }
  return (shopifyCache[host] = all);
}
const notBundle = p => !/bundle|duo|trio|set of|gift|sample|refurb|mystery|subscription|test /i.test(p.title) && !/bundle|refurb/i.test(p.product_type || '');
async function fromShopify(e) {
  const list = await shopifyList(e.host), out = [];
  for (const pick of e.picks) {
    const p = typeof pick === 'string' ? list.find(x => x.handle === pick) : list.find(x => pick.test(x.title) && (!e.vendor || x.vendor === e.vendor) && notBundle(x) && x.images[0] && x.variants.some(v => v.available && +v.price > 0));
    if (!p) { console.warn(`  ? ${e.host}: no match for ${pick}`); continue; }
    const v = p.variants.find(x => x.available && +x.price > 0) || p.variants[0], img = p.images[0]?.src || '';
    const brand = e.brand || (e.brandMap && e.brandMap[p.vendor]) || p.vendor;
    out.push({ brand, title: tidyTitle(p.title, brand), price: +v.price, currency: 'USD',
      image: squarify(img), url: `https://${e.host.replace(/^www\./, '')}/products/${p.handle}`, merchant: e.merchant, category: e.category,
      keywords: [...words(p.title), ...words(p.product_type), ...(e.kw ? words(e.kw) : []), ...(p.tags || []).slice(0, 6).flatMap(words)] });
  }
  return out;
}
async function fromShopifyTop(e) {
  const list = (await shopifyList(e.host)).filter(p => notBundle(p) && p.images[0] && p.variants.some(v => v.available && +v.price > 0)
    && (e.match.test(p.product_type || '') || e.match.test(p.title)) && !(e.exclude && e.exclude.test(p.title)) && (!e.vendor || p.vendor === e.vendor))
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at)).slice(0, e.take);
  return list.map(p => { const brand = e.brand || p.vendor, v = p.variants.find(x => x.available && +x.price > 0);
    return { brand, title: tidyTitle(p.title, brand), price: +v.price, currency: 'USD', image: squarify(p.images[0].src), url: `https://${e.host.replace(/^www\./, '')}/products/${p.handle}`, merchant: e.merchant, category: e.category,
      keywords: [...words(p.title), ...words(p.product_type), ...(e.kw ? words(e.kw) : []), ...(p.tags || []).slice(0, 6).flatMap(words)] }; });
}
async function fromOg(e) {
  const r = await get(e.url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = (await r.text()).slice(0, 600000);
  const meta = n => { const m = t.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)`, 'i')) || t.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, 'i')); return m ? m[1].replace(/&amp;/g, '&') : ''; };
  let ld = '';   // JSON-LD Product.image is the actual product shot; og:image is sometimes a marketing banner
  for (const m of t.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) { try { const j = JSON.parse(m[1]); for (const o of (Array.isArray(j) ? j : [j, ...(j['@graph'] || [])])) { const ty = [].concat(o['@type'] || []); if (ty.includes('Product') && o.image) { ld = Array.isArray(o.image) ? o.image[0] : (o.image.url || o.image); break; } } } catch { } if (ld) break; }
  const image = (typeof ld === 'string' && ld) || meta('og:image:secure_url') || meta('og:image'); if (!image) throw new Error('no product image');
  const priceMeta = +(meta('product:price:amount') || meta('og:price:amount') || (t.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return [{ brand: e.brand, title: e.title, price: priceMeta > e.price * 0.3 && priceMeta < e.price * 3 ? priceMeta : e.price, currency: 'USD', image: squarify(new URL(image, e.url).toString()), url: e.url, merchant: e.merchant, category: e.category, keywords: [...words(e.brand + ' ' + e.title), ...words(e.kw)] }];
}

// ---------- Main ----------
const byCat = {}, seen = new Set();
for (const e of SPEC) {
  let items = [];
  try { items = e.kind === 'shopify' ? await fromShopify(e) : e.kind === 'shopify-top' ? await fromShopifyTop(e) : await fromOg(e); } catch (err) { console.warn(`  FAIL ${e.kind} ${e.host || e.url}: ${err.message}`); continue; }
  for (const p of items) {
    const key = (p.category + '|' + p.brand + '|' + p.title).toLowerCase();   // colour/size variants share a title → keep the first
    if (seen.has(key)) continue; seen.add(key);
    if (!(await isImage(p.image))) { console.warn(`  FAIL image failed: ${p.brand} ${p.title} ${p.image.slice(0, 80)}`); continue; }
    (byCat[p.category] ||= []).push(p);
    console.log(`  OK   ${p.category.padEnd(11)} ${p.brand} · ${p.title.slice(0, 48)} · $${p.price}`);
  }
}
let total = 0;
mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const [cat, list] of Object.entries(byCat)) {
  let v = validateProducts(list, cat);
  if (!v.ok && v.products.length) v = validateProducts(v.products, cat);   // drop the odd bad row, keep the rest
  const prevFile = join(ROOT, 'data', `${cat}.json`), prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')) : [];
  if (!v.ok || v.products.length < Math.max(5, Math.floor(prev.length * 0.6))) { console.error(`KEEP ${cat}: run returned ${v.products.length} valid products (previous ${prev.length}) — keeping previous file`); total += prev.length; continue; }
  if (!DRY) writeFileSync(join(ROOT, 'data', `${cat}.json`), JSON.stringify(v.products, null, 1) + '\n');
  total += v.products.length;
  console.log(`${cat}: ${v.products.length} products, ${v.stats.merchants} merchants${DRY ? ' (dry)' : ''}`);
}
console.log(`total ${total} products`);
