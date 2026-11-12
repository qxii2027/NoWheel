# Release page

Static landing page for NoWheel. Deploy with Cloudflare Pages:

- Root directory: `release-page`
- Framework preset: None
- Build command: leave empty
- Build output directory: `/`

Local preview:

```bash
npx serve release-page
```

or:

```bash
python -m http.server 8000 --directory release-page
```

GSAP 3.15.1 is vendored under `vendor/`; the page makes no external requests. The page defaults to Chinese and stores the English preference in `localStorage` (`nowheel-lang`).
