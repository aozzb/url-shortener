#!/usr/bin/env bash
# End-to-end smoke test against a running instance.
# Usage: ADMIN_TOKEN=... scripts/smoke.sh [base-url]   (default http://127.0.0.1:8787)
set -u
BASE="${1:-http://127.0.0.1:8787}"
TOKEN="${ADMIN_TOKEN:-}"
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected $2, got $3)"; fail=1; fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "GET / serves UI" 200 "$(status "$BASE/")"

body=$(curl -s -X POST "$BASE/api/links" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
code=$(echo "$body" | sed -nE 's/.*"code":"([A-Za-z0-9]{6})".*/\1/p')
check "POST creates link" 6 "${#code}"

check "POST bare domain" 201 "$(status -X POST "$BASE/api/links" -d '{"url":"example.com"}')"
check "POST notaurl" 400 "$(status -X POST "$BASE/api/links" -d '{"url":"notaurl"}')"
check "POST invalid JSON" 400 "$(status -X POST "$BASE/api/links" -d '{bad')"

check "redirect 302" 302 "$(status "$BASE/$code")"
check "redirect Location" "https://example.com/" "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/$code")"
check "HEAD gets 302" 302 "$(status -I "$BASE/$code")"
check "WhatsApp UA gets 302" 302 "$(status -A 'WhatsApp/2.23' "$BASE/$code")"
check "unknown code 404" 404 "$(status "$BASE/abcdef")"

check "list without token 401" 401 "$(status "$BASE/api/links")"
check "delete without token 401" 401 "$(status -X DELETE "$BASE/api/links/$code")"

if [ -n "$TOKEN" ]; then
  check "list with token 200" 200 "$(status -H "authorization: Bearer $TOKEN" "$BASE/api/links")"
  check "delete with token 200" 200 "$(status -X DELETE -H "authorization: Bearer $TOKEN" "$BASE/api/links/$code")"
  # Deletes can take up to ~60s to propagate on live KV, so only assert this locally.
  case "$BASE" in *127.0.0.1*|*localhost*) check "redirect after delete 404" 404 "$(status "$BASE/$code")" ;; esac
else
  echo "SKIP  admin checks (set ADMIN_TOKEN)"
fi

exit $fail
