/**
 * Search and social metadata for the public site: one entry per indexable page,
 * rendered into <head>, the sitemap and robots.txt. Titles stay near 60
 * characters and descriptions near 155, and every page gets its own of each.
 */

export interface SitePage {
  id: string;
  path: string;
  /** Fragment in public/site/pages (absent for /docs, which has its own HTML). */
  fragment?: string;
  title: string;
  description: string;
  /** Short label for breadcrumbs and the share image. */
  name: string;
  ogImage: string;
  ogAlt: string;
  changefreq: 'weekly' | 'monthly';
  priority: number;
}

export const SITE_NAME = 'Pigeon';

export const PAGES: SitePage[] = [
  {
    id: 'home',
    path: '/',
    fragment: 'home.html',
    name: 'Home',
    title: 'Pigeon: Transactional Email API for Developers | Onja',
    description:
      'Send password resets, receipts and alerts from your own domain with one API call. An affordable transactional email API with retries, tracking and logs.',
    ogImage: '/og/home.png',
    ogAlt: 'Pigeon: email that lands. A transactional email API by Onja.',
    changefreq: 'weekly',
    priority: 1.0,
  },
  {
    id: 'how-it-works',
    path: '/how-it-works',
    fragment: 'how-it-works.html',
    name: 'How it works',
    title: 'How Pigeon Works: Send Email From Your App in 3 Steps',
    description:
      'Get an API key, verify your domain with DNS records we prepare, then send transactional email with one POST request from Node.js, Python or Go.',
    ogImage: '/og/how-it-works.png',
    ogAlt: 'How Pigeon works: send transactional email from your app in three steps.',
    changefreq: 'monthly',
    priority: 0.8,
  },
  {
    id: 'features',
    path: '/features',
    fragment: 'features.html',
    name: "What's included",
    title: 'Email API Features: Templates, Attachments, Logs | Pigeon',
    description:
      'Everything an email sending API should do: templates, attachments, inline images, idempotent sends, delivery tracking and a 90-day searchable email log.',
    ogImage: '/og/features.png',
    ogAlt: 'Pigeon features: every email API feature you need, already done.',
    changefreq: 'monthly',
    priority: 0.8,
  },
  {
    id: 'reliability',
    path: '/reliability',
    fragment: 'reliability.html',
    name: 'Reliability',
    title: 'Reliable Transactional Email Delivery | Pigeon',
    description:
      'Queued before we reply, retried with backoff, never sent twice, bounces suppressed automatically. How Pigeon keeps password resets and receipts arriving.',
    ogImage: '/og/reliability.png',
    ogAlt: "Pigeon reliability: a password reset can't afford to get lost.",
    changefreq: 'monthly',
    priority: 0.7,
  },
  {
    id: 'faq',
    path: '/faq',
    fragment: 'faq.html',
    name: 'FAQ',
    title: 'Transactional Email API FAQ | Pigeon',
    description:
      'Own domain, SDKs, timeouts, attachments, limits and support: straight answers to the questions developers ask before choosing an email sending API.',
    ogImage: '/og/faq.png',
    ogAlt: 'Pigeon FAQ: the questions developers ask first about a transactional email API.',
    changefreq: 'monthly',
    priority: 0.7,
  },
  {
    id: 'docs',
    path: '/docs',
    name: 'Docs',
    title: 'Pigeon Docs: Send Email from Node.js, Python & Go',
    description:
      'Developer guide for the Pigeon email API: copy-paste clients for Node.js, Python and Go, attachments, templates, idempotency, delivery events and error codes.',
    ogImage: '/og/docs.png',
    ogAlt: 'Pigeon developer guide: send email from Node.js, Python and Go.',
    changefreq: 'weekly',
    priority: 0.9,
  },
];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON for a <script type="application/ld+json"> block, safe against "</script>". */
const ld = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

/** Visible FAQ questions and answers, so the FAQPage data always matches the page. */
export function extractFaq(html: string): { q: string; a: string }[] {
  const text = (s: string) =>
    s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => ({ q: text(m[1]), a: text(m[2]) }));
}

/** Everything that goes in <head> for a page: title, description, canonical, OG, Twitter, JSON-LD. */
export function renderHead(page: SitePage, origin: string, extra: { faq?: { q: string; a: string }[] } = {}): string {
  const url = origin + page.path;
  const image = origin + page.ogImage;
  const org = {
    '@type': 'Organization',
    '@id': `${origin}/#org`,
    name: 'Onja',
    url: 'https://onja.org',
    logo: `${origin}/brand/logo-512.png`,
    email: 'internal.development@onja.org',
  };
  const graph: Record<string, unknown>[] = [
    org,
    { '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: SITE_NAME, publisher: { '@id': `${origin}/#org` } },
    {
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: page.title,
      description: page.description,
      isPartOf: { '@id': `${origin}/#website` },
      primaryImageOfPage: image,
      inLanguage: 'en',
    },
  ];
  if (page.id === 'home') {
    graph.push({
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any',
      description: page.description,
      url: `${origin}/`,
      publisher: { '@id': `${origin}/#org` },
      featureList: [
        'Transactional email API',
        'Send from your own domain with DKIM, SPF and DMARC',
        'Idempotent sends and automatic retries',
        'Templates, attachments and inline images',
        'Delivery tracking and a 90-day email log',
      ],
    });
  } else {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: page.name, item: url },
      ],
    });
  }
  if (extra.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: extra.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    });
  }

  return [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta name="robots" content="index, follow, max-image-preview:large">`,
    `<meta property="og:type" content="${page.id === 'home' ? 'website' : 'article'}">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    `<meta property="og:description" content="${esc(page.description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(page.ogAlt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(page.title)}">`,
    `<meta name="twitter:description" content="${esc(page.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="twitter:image:alt" content="${esc(page.ogAlt)}">`,
    `<script type="application/ld+json">${ld({ '@context': 'https://schema.org', '@graph': graph })}</script>`,
  ].join('\n');
}

export function renderSitemap(origin: string, lastmod: string): string {
  const urls = PAGES.map(
    (p) =>
      `  <url><loc>${esc(origin + p.path)}</loc><lastmod>${lastmod}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority.toFixed(1)}</priority></url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Admin pages are not disallowed here on purpose: a crawler must be able to fetch
 * them to see their X-Robots-Tag: noindex. Only the JSON APIs are off limits.
 */
export function renderRobots(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /webhooks/\n\nSitemap: ${origin}/sitemap.xml\n`;
}
