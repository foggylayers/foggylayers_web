export function GET() {
  return new Response('User-agent: *\nAllow: /\nDisallow: /cart/\nDisallow: /order/\nDisallow: /api/\nDisallow: /admin/\nSitemap: https://foggylayers.com/sitemap.xml\n', {headers:{'Content-Type':'text/plain'}});
}
