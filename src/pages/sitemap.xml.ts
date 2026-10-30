import products from '../data/products.json';
export function GET(){
 const paths=['/','/shop/','/custom-printing/','/design-services/','/project/','/about/','/shipping-pickup/','/privacy/',...products.map(p=>`/shop/${p.id}/`)];
 return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path=>`<url><loc>https://foggylayers.com${path}</loc></url>`).join('')}</urlset>`,{headers:{'Content-Type':'application/xml'}});
}
