// Arma el sitio para publicar. Vercel lo ejecuta en cada cambio (ver vercel.json).
//  1. Lee tienda.config.json (fijo) y data/ajustes.json + data/productos/*.json (editables desde /admin)
//  2. Genera dist/index.html y dist/<producto>.html a partir de partials/_shell.html + partials/<slug>.json
//     (contenido de investigación y storytelling, que NO se edita desde el admin)
//  3. Escribe canonical, Open Graph, datos estructurados, robots.txt y sitemap.xml
// Uso local: node scripts/build.mjs  →  servir la carpeta dist/
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'data');
const DIST = join(ROOT, 'dist');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const config = readJson(join(ROOT, 'tienda.config.json'));
const ajustes = readJson(join(DATA, 'ajustes.json'));

const SITE = (process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : config.site_url || 'http://localhost:5601').replace(/\/$/, '');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const abs = (path) => `${SITE}/${String(path).replace(/^\//, '')}`;

const T = {
  whatsapp: str(ajustes.whatsapp).replace(/\D/g, ''),
  instagram: str(ajustes.instagram).replace(/^@/, ''),
  tiktok: str(ajustes.tiktok).replace(/^@/, ''),
  email: str(ajustes.email),
  facebook: str(ajustes.facebook),
  ciudad: str(ajustes.ciudad),
  region: str(ajustes.region),
  envios: str(ajustes.envios),
  hero_titulo: str(ajustes.hero_titulo),
  hero_destacado: str(ajustes.hero_destacado),
  hero_bajada: str(ajustes.hero_bajada),
};

const faltan = ['whatsapp', 'ciudad', 'email'].filter((k) => !T[k]);
if (faltan.length) throw new Error(`Faltan datos obligatorios en data/ajustes.json: ${faltan.join(', ')}`);
if (!/^569\d{8}$/.test(T.whatsapp)) throw new Error(`WhatsApp inválido "${T.whatsapp}": usa formato 569XXXXXXXX`);

// ---------- 1. Productos ----------
function readFolder(folder) {
  const dir = join(DATA, folder);
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const items = [];
  for (const file of files) {
    try { items.push({ slug: basename(file, '.json'), ...readJson(join(dir, file)) }); }
    catch (e) { console.warn(`⚠️  Se omitió productos/${file}: ${e.message}`); }
  }
  return items;
}
const num = (v, def) => (v !== '' && v !== null && Number.isFinite(Number(v)) ? Number(v) : def);
const byOrder = (a, b) => num(a.orden, 1000) - num(b.orden, 1000) || a.nombre.localeCompare(b.nombre, 'es');

const productosAll = readFolder('productos')
  .map((p) => ({
    slug: p.slug,
    nombre: str(p.nombre) || p.slug,
    resumen: str(p.resumen),
    foto: str(p.foto) || 'img/logo.webp',
    foto_cutout: str(p.foto_cutout),
    formatos: Array.isArray(p.formatos) && p.formatos.length ? p.formatos.map(str).filter(Boolean) : ['Consultar'],
    beneficios: Array.isArray(p.beneficios) ? p.beneficios.map(str).filter(Boolean) : [],
    categoria: str(p.categoria) === 'cuidado' ? 'cuidado' : 'hierbas',
    etiqueta: str(p.etiqueta),
    agotado: p.agotado === true,
    visible: p.visible !== false,
    orden: num(p.orden, 1000),
  }))
  .sort(byOrder);
const productos = productosAll.filter((p) => p.visible);
const porSlug = Object.fromEntries(productosAll.map((p) => [p.slug, p]));

function readPartial(slug) {
  const path = join(ROOT, 'partials', `${slug}.json`);
  if (!existsSync(path)) throw new Error(`Falta partials/${slug}.json (contenido editorial del producto)`);
  return readJson(path);
}

// ---------- 2. Marcadores globales (compartidos por todas las páginas) ----------
const fuenteParam = (f, pesos) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${pesos}`;
const fuentes = config.fuentes || {};
const FUENTES_URL = `https://fonts.googleapis.com/css2?${fuenteParam(fuentes.titulos || 'Fraunces', '9..144,340;9..144,500;9..144,600;9..144,700')}&${fuenteParam(fuentes.texto || 'Work Sans', '400;500;600;700')}&display=swap`;

const GLOBAL_VARS = {
  WHATSAPP: T.whatsapp,
  WHATSAPP_DISPLAY: '+56 9 ' + T.whatsapp.slice(3, 7) + ' ' + T.whatsapp.slice(7),
  EMAIL: T.email,
  INSTAGRAM: T.instagram,
  TIKTOK: T.tiktok,
  FACEBOOK: T.facebook,
  FUENTES_URL,
  AUDIO_SRC: 'audio/musica.mp3',
  YEAR: String(new Date().getFullYear()),
};

const shellSrc = readFileSync(join(ROOT, 'partials', '_shell.html'), 'utf8');

function renderShell(vars, main, seoHead) {
  let out = shellSrc.replace('<!-- SEO:HEAD -->', seoHead).replace('<!--MAIN-->', main);
  const all = { ...GLOBAL_VARS, ...vars };
  const missing = new Set();
  out = out.replace(/%%([A-Z0-9_]+)%%/g, (m, key) => {
    const v = all[key];
    if (v === undefined || v === null) { missing.add(key); return m; }
    return String(v);
  });
  if (missing.size) throw new Error(`Faltan marcadores: ${[...missing].join(', ')}`);
  return out;
}

const jsonLdScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function seoHead({ canonical, ogType, title, description, image, jsonLd }) {
  return `<link rel="canonical" href="${canonical}">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="Hierbas Medicinales Rengo">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  <meta property="og:locale" content="es_CL">
  <meta name="twitter:card" content="summary_large_image">
  ${jsonLd.map(jsonLdScript).join('\n  ')}`;
}

// ---------- 3. Piezas de HTML reutilizables ----------
const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4L19 7"/></svg>';
const arrowIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M7 7h10v10"/></svg>';

function formatChips(p, interactive) {
  if (!interactive || p.formatos.length < 2) {
    return `<span class="qty-row"><span class="qty-label">Formato</span><span class="qty-chip qty-chip-static"><span>${esc(p.formatos[0])}</span></span></span>`;
  }
  return `<span class="qty-row"><span class="qty-label">Cantidad</span>${p.formatos.map((f, i) => `<label class="qty-chip"><input type="radio" name="qty-${p.slug}" value="${esc(f)}"${i === 0 ? ' checked' : ''}><span>${esc(f)}</span></label>`).join('')}</span>`;
}

function waHref(p, formato) {
  const text = `Hola, quiero comprar ${p.nombre}${formato ? ` (${formato})` : ''}`;
  return `https://wa.me/${T.whatsapp}?text=${encodeURIComponent(text)}`;
}

function productCard(p) {
  const benMostrar = p.beneficios.slice(0, 3);
  const extra = p.beneficios.length - benMostrar.length;
  return `
        <article class="product-card reveal">
          <div class="product-card__media">
            ${p.agotado ? '<span class="badge badge--soldout">Agotado</span>' : p.etiqueta ? `<span class="badge">${esc(p.etiqueta)}</span>` : ''}
            <img src="${esc(p.foto)}" alt="${esc(p.nombre)} ${esc(p.formatos.join('/'))} — Hierbas Medicinales Rengo" loading="lazy">
          </div>
          <div class="product-card__body">
            <span class="product-card__eyebrow">${esc(p.resumen)}</span>
            <h3>${esc(p.nombre)}</h3>
            ${formatChips(p, true).replace('qty-row', 'qty-row qty-row--card')}
            <ul class="product-card__benefits">
              ${benMostrar.map((b) => `<li>${checkIcon}${esc(b)}</li>`).join('')}
              ${extra > 0 ? `<li class="more">+ ${extra} beneficio${extra === 1 ? '' : 's'} más</li>` : ''}
            </ul>
            <div class="product-card__actions" data-wa-card data-wa-product="${esc(p.nombre)}" data-wa-number="${T.whatsapp}">
              ${p.agotado
                ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(waHref(p, ''))}">Consultar stock</a>`
                : `<a class="btn btn-buy js-buy" target="_blank" rel="noopener" href="${esc(waHref(p, p.formatos[0]))}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.5 3h2l2.7 12.6a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21.5 8H6"/></svg>
                    Comprar
                  </a>`}
              <a class="shelf-more" href="${p.slug}.html">Ver detalles</a>
            </div>
          </div>
        </article>`;
}

function careCard(p) {
  return `
        <article class="care-card reveal">
          <a class="care-card__media" href="${p.slug}.html" tabindex="-1" aria-hidden="true">
            ${p.etiqueta ? `<span class="badge">${esc(p.etiqueta)}</span>` : ''}
            <img src="${esc(p.foto)}" alt="${esc(p.nombre)} ${esc(p.formatos.join('/'))} — Hierbas Medicinales Rengo" loading="lazy">
          </a>
          <div class="care-card__body">
            <span class="eyebrow">${esc(p.formatos.join(' · '))}</span>
            <h3>${esc(p.nombre)}</h3>
            <p>${esc(p.resumen)}</p>
            <ul class="care-card__list">
              ${p.beneficios.slice(0, 3).map((b) => `<li>${checkIcon}${esc(b)}</li>`).join('')}
            </ul>
            <div class="care-card__actions">
              <a class="btn btn-buy btn-sm js-buy" target="_blank" rel="noopener" href="${esc(waHref(p, p.formatos[0]))}">${p.agotado ? 'Consultar stock' : 'Consultar por WhatsApp'}</a>
              <a class="shelf-more" href="${p.slug}.html">Ver detalles</a>
            </div>
          </div>
        </article>`;
}

// ---------- 4. Página de inicio ----------
function buildHome() {
  const seoTitulo = str(config.seo_titulo);
  const seoDescripcion = str(config.seo_descripcion);
  const ogImage = abs('img/og-banner.jpg');
  const canonical = `${SITE}/`;

  const jsonLd = [{
    '@context': 'https://schema.org',
    '@type': config.schema_tipo || 'LocalBusiness',
    name: config.nombre,
    description: seoDescripcion,
    image: abs('img/favicon.png'),
    telephone: `+${T.whatsapp}`,
    email: T.email,
    url: canonical,
    priceRange: '$$',
    areaServed: [T.ciudad, T.region, 'Chile'].filter(Boolean),
    sameAs: [T.instagram && `https://instagram.com/${T.instagram}`, T.tiktok && `https://tiktok.com/@${T.tiktok}`, T.facebook].filter(Boolean),
  }];

  const main = `
<main id="top">
  <section class="hero">
    <div class="wrap hero-inner">
      <div class="hero-copy reveal">
        <span class="eyebrow">Medicina natural</span>
        <h1>${esc(T.hero_titulo)} <em>${esc(T.hero_destacado)}</em></h1>
        <p class="hero-lead">${esc(T.hero_bajada)}</p>
        <div class="hero-cta">
          <a class="btn btn-primary" href="https://wa.me/${T.whatsapp}?text=${encodeURIComponent('Hola, quiero más información')}" target="_blank" rel="noopener">Contactar por WhatsApp</a>
          <a class="btn btn-ghost" href="#productos">Ver productos</a>
        </div>
      </div>
      <div class="hero-showcase reveal" aria-hidden="true">
        <span class="hero-slide"><img src="img/maqui-sinfondo.webp" alt=""></span>
        <span class="hero-slide"><img src="img/polen-sinfondo.webp" alt=""></span>
        <span class="hero-slide"><img src="img/maca-amarilla-sinfondo.webp" alt=""></span>
        <span class="hero-slide"><img src="img/macanegra-sinfondo.webp" alt=""></span>
      </div>
    </div>
  </section>

  <section class="productos" id="productos">
    <div class="wrap">
      <div class="sec-head reveal">
        <span class="eyebrow">Selección natural</span>
        <h2>Nuestros productos</h2>
        <p>Hierbas medicinales 100% naturales, seleccionadas por su calidad y pureza. Iremos sumando nuevas variedades a medida que sigamos creciendo.</p>
      </div>
      <a class="flyer-banner reveal" href="https://wa.me/${T.whatsapp}?text=${encodeURIComponent('Hola, quiero más información')}" target="_blank" rel="noopener">
        <img src="img/flyer-productos.jpg" alt="Afiche de productos Hierbas Medicinales Rengo" loading="lazy">
      </a>
      <div class="product-grid">${productos.map(productCard).join('')}
      </div>
    </div>
  </section>

  <section class="cuidado" id="cuidado">
    <div class="wrap">
      <div class="sec-head reveal">
        <span class="eyebrow">Cuidado de la piel</span>
        <h2>Cuidados para tu piel, <em>todos los días</em></h2>
        <p>Además de nuestras hierbas, ahora tenemos productos de cuidado personal para hidratar y refrescar tu piel. Consulta disponibilidad por WhatsApp.</p>
      </div>
      <div class="care-grid">${productos.filter((p) => p.categoria === 'cuidado').map(careCard).join('')}
      </div>
    </div>
  </section>

  <section class="somos" id="somos">
    <div class="wrap somos-grid">
      <div class="somos-text reveal">
        <span class="eyebrow">Quiénes somos</span>
        <h2>Un puente entre la naturaleza y tu bienestar</h2>
        <p>Hierbas Medicinales Rengo nace del trabajo de un profesional de la salud formado en medicina natural, que decidió compartir hierbas medicinales seleccionadas por su calidad y sus propiedades tradicionales.</p>
        <p>Cada producto se selecciona a mano y se trae directo desde su lugar de origen, sin intermediarios, cuidando que llegue a tus manos tal como la naturaleza lo entrega.</p>
      </div>
      <div class="pic reveal">
        <img src="img/sur-de-chile.jpg" alt="Paisaje natural de bosque nativo, lago y montañas" loading="lazy">
      </div>
    </div>
  </section>

  <section class="contacto" id="contacto">
    <div class="wrap">
      <div class="sec-head reveal">
        <span class="eyebrow">Envíos y contacto</span>
        <h2>Conversemos por WhatsApp</h2>
        <p>Escríbenos para consultar disponibilidad y precios de nuestras hierbas.</p>
      </div>
      <div class="contacto-grid">
        <div class="reveal">
          <div class="info-list">
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.65-2.05-.17-.3-.02-.46.13-.6"/><path d="M12.02 2C6.5 2 2.02 6.48 2.02 12c0 1.87.5 3.62 1.4 5.13L2 22l4.98-1.31A9.96 9.96 0 0 0 12.02 22C17.53 22 22 17.52 22 12S17.53 2 12.02 2z"/></svg>
              <div><h4>WhatsApp</h4><p>${GLOBAL_VARS.WHATSAPP_DISPLAY}</p></div>
            </div>
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="7" width="15" height="10" rx="1.5"/><path d="M16 10.5h3.5L22 14v3h-6"/><circle cx="6.5" cy="18.5" r="1.7"/><circle cx="17.5" cy="18.5" r="1.7"/></svg>
              <div><h4>Envíos</h4><p>${esc(T.envios)}</p></div>
            </div>
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>
              <div><h4>Correo</h4><p>${esc(T.email)}</p></div>
            </div>
          </div>
        </div>
        <div class="reveal">
          <div class="ship-card">
            <div class="ship-visual" aria-hidden="true">
              <svg viewBox="0 0 140 300">
                <path class="ship-leaf" d="M70 6C36 46 16 96 16 156c0 56 22 104 54 138 32-34 54-82 54-138C124 96 104 46 70 6z"/>
                <line class="ship-route" x1="70" y1="44" x2="70" y2="270"/>
                <circle class="ship-pin" cx="70" cy="80" r="5"/>
                <circle class="ship-pin" cx="70" cy="150" r="5"/>
                <circle class="ship-pin" cx="70" cy="220" r="5"/>
                <circle class="ship-pin-end" cx="70" cy="268" r="8"/>
              </svg>
            </div>
            <div class="ship-content">
              <h3>Hacemos envíos a todo Chile</h3>
              <p>Despachamos tus hierbas a domicilio en cualquier región del país, con empaque cuidado y seguimiento de tu pedido.</p>
              <div class="ship-tags">
                <span class="ship-tag">Todo el país</span>
                <span class="ship-tag">Empaque cuidado</span>
                <span class="ship-tag">Encomiendas certificadas</span>
              </div>
              <a class="btn btn-primary btn-sm" href="https://wa.me/${T.whatsapp}?text=${encodeURIComponent('Hola, quiero consultar por un envío')}" target="_blank" rel="noopener">Consultar envío</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</main>`;

  const html = renderShell({
    TITLE: `${config.nombre} — ${config.rubro}`,
    SEO_DESCRIPCION: seoDescripcion,
    BRAND_HREF: '#top',
    LINK_SOMOS: '#somos', LINK_PRODUCTOS: '#productos', LINK_CUIDADO: '#cuidado', LINK_CONTACTO: '#contacto',
    WA_TEXT_DEFAULT: encodeURIComponent('Hola, quiero más información'),
  }, main, seoHead({ canonical, ogType: 'website', title: seoTitulo, description: seoDescripcion, image: ogImage, jsonLd }));

  writeFileSync(join(DIST, 'index.html'), html);
}

// ---------- 5. Páginas de producto ----------
function benefitsSection(p, partial) {
  const items = partial.benefits.map((b) => `
        <div class="benefit">
          <span class="check">${checkIcon}</span>
          <p><strong>${esc(b.titulo)}</strong> ${esc(b.texto)}</p>
        </div>`).join('');
  return `
  <section class="benefits">
    <div class="wrap">
      <div class="sec-head reveal">
        <span class="eyebrow">Propiedades</span>
        <h2>${esc(partial.benefits_titulo)}</h2>
      </div>
      <div class="benefits-grid reveal">${items}
      </div>
      <p class="product-note">Esta información corresponde a las propiedades nutricionales y al uso tradicional de ${esc(p.nombre.toLowerCase())}, no a indicaciones médicas certificadas. Este producto no reemplaza un tratamiento médico; consulta a tu médico si tienes alguna condición de salud.</p>
    </div>
  </section>`;
}

function researchSection(partial) {
  return `
  <section class="research">
    <div class="wrap">
      <div class="sec-head reveal">
        <span class="eyebrow">Investigación científica</span>
        <h2>${esc(partial.research_titulo)}</h2>
      </div>
      <div class="research-card reveal">
        <span class="quote-mark" aria-hidden="true">&ldquo;</span>
        <p>${partial.research_parrafo}</p>
        <p class="research-caveat"><strong>Importante:</strong> ${esc(partial.research_caveat)}</p>
        <a class="research-link" href="${esc(partial.research_link_url)}" target="_blank" rel="noopener">${esc(partial.research_link_texto)}${arrowIcon}</a>
      </div>
    </div>
  </section>`;
}

function relatedSection(partial) {
  const cards = partial.related.map((slug) => {
    const rp = porSlug[slug];
    if (!rp) return '';
    return `
        <a class="related-card" href="${slug}.html">
          <img src="${esc(rp.foto)}" alt="${esc(rp.nombre)}" loading="lazy">
          <span>${esc(rp.nombre)} ${arrowIcon}</span>
        </a>`;
  }).join('');
  return `
  <section class="related">
    <div class="wrap">
      <div class="sec-head reveal">
        <span class="eyebrow">Sigue explorando</span>
        <h2>También te puede interesar</h2>
      </div>
      <div class="related-grid reveal">${cards}
      </div>
    </div>
  </section>`;
}

function productBanner(p, partial) {
  const cutout = p.foto_cutout ? `<img class="product-banner-cutout" src="${esc(p.foto_cutout)}" alt="${esc(p.nombre)} ${esc(p.formatos.join('/'))} — Hierbas Medicinales Rengo">` : '';
  const photo = !cutout && p.categoria === 'cuidado'
    ? `<img class="product-banner-photo" src="${esc(p.foto)}" alt="${esc(p.nombre)} ${esc(p.formatos.join('/'))} — Hierbas Medicinales Rengo">` : '';
  return `
  <section class="product-hero">
    <div class="wrap">
      <div class="product-banner${cutout ? '' : ' no-cutout'}">
        <div class="product-banner-bg" style="background-image:url('${esc(partial.banner_bg)}')"></div>
        <div class="product-banner-overlay"></div>
        ${cutout}${photo}
        <div class="product-banner-copy">
          <span class="eyebrow">${esc(partial.eyebrow)}</span>
          <h1>${esc(p.nombre)}</h1>
          <p class="lead">${esc(partial.lead)}</p>
          ${formatChips(p, p.formatos.length > 1)}
          <div class="product-cta">
            <a class="btn btn-primary js-buy" href="${esc(waHref(p, p.formatos[0]))}" target="_blank" rel="noopener">${p.agotado ? 'Consultar stock' : 'Consultar disponibilidad'}</a>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

function buildProducto(p) {
  const partial = readPartial(p.slug);
  const canonical = `${SITE}/${p.slug}.html`;
  const ogImage = abs(p.foto_cutout || p.foto);
  const description = `${p.nombre} 100% natural: ${p.resumen} Consulta disponibilidad por WhatsApp.`;

  const jsonLd = [{
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Productos', item: `${SITE}/#productos` },
      { '@type': 'ListItem', position: 3, name: p.nombre, item: canonical },
    ],
  }];

  const main = `
<main>
  <div class="wrap back-bar">
    <a class="back-link" href="index.html#productos">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      Volver a productos
    </a>
  </div>
  ${productBanner(p, partial)}
  ${benefitsSection(p, partial)}
  ${researchSection(partial)}
  ${relatedSection(partial)}
</main>`;

  const html = renderShell({
    TITLE: `${p.nombre} — Hierbas Medicinales Rengo`,
    SEO_DESCRIPCION: description,
    BRAND_HREF: 'index.html',
    LINK_SOMOS: 'index.html#somos', LINK_PRODUCTOS: 'index.html#productos', LINK_CUIDADO: 'index.html#cuidado', LINK_CONTACTO: 'index.html#contacto',
    WA_TEXT_DEFAULT: encodeURIComponent(`Hola, quiero consultar disponibilidad de ${p.nombre}`),
  }, main, seoHead({ canonical, ogType: 'product', title: `${p.nombre} — Hierbas Medicinales Rengo`, description, image: ogImage, jsonLd }));

  writeFileSync(join(DIST, `${p.slug}.html`), html);
}

// ---------- 6. Ensamblar dist/ ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, 'img'), join(DIST, 'img'), { recursive: true });
if (existsSync(join(ROOT, 'audio'))) cpSync(join(ROOT, 'audio'), join(DIST, 'audio'), { recursive: true });
cpSync(join(ROOT, 'admin'), join(DIST, 'admin'), { recursive: true });
writeFileSync(join(DIST, 'admin', 'config.yml'), readFileSync(join(ROOT, 'admin', 'config.yml'), 'utf8')
  .replace('%%GITHUB_REPO%%', str(config.github_repo))
  .replace(/%%SITE_URL%%/g, `${SITE}/`));
writeFileSync(join(DIST, 'styles.css'), readFileSync(join(ROOT, 'styles.css'), 'utf8'));

buildHome();
for (const p of productos) buildProducto(p);

writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${SITE}/sitemap.xml\n`);
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>1.0</priority></url>
${productos.map((p) => `  <url><loc>${SITE}/${p.slug}.html</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`).join('\n')}
</urlset>
`);

console.log(`✅ sitio listo en dist/ (${productos.length} productos) para ${SITE}`);
