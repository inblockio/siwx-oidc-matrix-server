# Element-origin security headers — element-web upstream `apps/web/README.md`
# "Important Security Notes" (checklist S1 in
# docs/2026-07-31-element-deploy-audit-checklist.md; Section 1). These four
# headers are exactly what S1 documents, no more:
#
#   X-Frame-Options: SAMEORIGIN
#   Content-Security-Policy: frame-ancestors 'self'
#   X-Content-Type-Options: nosniff
#   X-XSS-Protection: 1; mode=block
#
# CSP is deliberately frame-ancestors ONLY. `frame-ancestors` is a header-only
# CSP directive per spec (it has no effect as a <meta> tag), which is why it
# lives here rather than in the app bundle. The upstream `index.html` ships
# its OWN `script-src`/etc. CSP as a <meta> tag (build-time, out of scope for
# this nginx layer) — S1 says to ADD `frame-ancestors` to an *existing header*
# CSP only if one is already set at the header level: "if you are already
# setting a Content-Security-Policy header elsewhere, you should modify it to
# include the frame-ancestors directive instead of adding that last line."
# We set none at the header level (confirmed live 2026-07-31: no CSP header
# on either origin), so a fresh single-directive header is the correct,
# non-clobbering move — it cannot conflict with the meta-tag CSP because
# frame-ancestors is ignored there anyway, and browsers apply BOTH a header
# CSP and a meta CSP as independent policies (most restrictive wins per
# directive), not merged/overwritten.
#
# X-XSS-Protection is legacy/deprecated — modern browsers (Chrome removed the
# feature; see MDN) ignore it — but S1 still lists it "for basic XSS
# protection in legacy browsers," so it is included here for parity with the
# official recommendation, not because it does anything on a current browser.
#
# `always` on every line: without it, add_header is skipped on non-2xx/3xx
# responses (error pages), which is exactly where a clickjacking/XSS
# mitigation matters most.
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Content-Security-Policy "frame-ancestors 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
