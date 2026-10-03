#!/usr/bin/env bash
# Set up a distributor's own SSV site, where its dealers' agents send their data.
# Run on the bench server, AFTER the site itself was created by whoever holds the
# database root password:
#
#   cd ~/frappe-bench && bench new-site rajlaxmi-dealers.rajlaxmiworld.in
#   bash new-distributor-site.sh rajlaxmi-dealers.rajlaxmiworld.in RAJLAXMI "Rajlaxmi Solutions Pvt Ltd"
#
# Steps (each is skipped when already done, so the script can be re-run):
#   1. multi-site mode, once per server: the existing site keeps its address (add-domain),
#      nginx answers each site on its own address; nginx config is checked and backed up
#   2. apps on the new site: erpnext, ssv_channel
#   3. ERPNext's first-run setup: company, INR, India, fiscal year from April
#   4. SSV Settings: this distributor as the principal, consent hold on, Dealer / Customer wording
#   5. the address: a Cloudflare tunnel route and DNS name for the site
#   6. checks: the site answers on its address and the existing site still does
set -euo pipefail

SITE="${1:?usage: new-distributor-site.sh <site hostname> <CODE> <distributor name>}"
CODE="${2:?principal code, e.g. RAJLAXMI}"
NAME="${3:?distributor name}"
EXISTING_SITE="${EXISTING_SITE:-ssv-test}"
EXISTING_HOST="${EXISTING_HOST:-ssv-test.rajlaxmiworld.in}"
TUNNEL_CONFIG="${TUNNEL_CONFIG:-/etc/cloudflared/config.yml}"
export PATH="$HOME/.local/bin:$PATH"
cd ~/frappe-bench

say() { printf '\n== %s\n' "$*"; }
[ -d "sites/$SITE" ] || { echo "Site $SITE does not exist yet. Create it first: bench new-site $SITE"; exit 1; }
[[ "$CODE" =~ ^[A-Z0-9_-]{2,30}$ ]] || { echo "CODE must be capitals/digits, e.g. RAJLAXMI"; exit 1; }

say "1. multi-site mode"
if ! grep -q '"dns_multitenant": *true' sites/common_site_config.json; then
  sudo cp -a /etc/nginx/conf.d/frappe-bench.conf "/etc/nginx/conf.d/frappe-bench.conf.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  grep -q "\"$EXISTING_HOST\"" "sites/$EXISTING_SITE/site_config.json" || bench setup add-domain "$EXISTING_HOST" --site "$EXISTING_SITE"
  bench config dns_multitenant on
  echo "multi-site mode on; $EXISTING_SITE keeps answering on $EXISTING_HOST"
fi
yes | bench setup nginx >/dev/null
sudo nginx -t
sudo systemctl reload nginx

say "2. apps"
installed=$(bench --site "$SITE" list-apps 2>/dev/null || true)
for app in erpnext ssv_channel; do
  echo "$installed" | grep -q "^$app" || bench --site "$SITE" install-app "$app"
done

say "3. ERPNext first-run setup"
cd sites
SSV_SITE="$SITE" SSV_NAME="$NAME" SSV_CODE="$CODE" ../env/bin/python - <<'PY'
import os
import frappe
site, name, code = os.environ["SSV_SITE"], os.environ["SSV_NAME"], os.environ["SSV_CODE"]
frappe.init(site=site, sites_path=".")
frappe.connect()
frappe.set_user("Administrator")
if not frappe.db.get_single_value("System Settings", "setup_complete"):
    from frappe.desk.page.setup_wizard.setup_wizard import setup_complete
    setup_complete({"language": "English", "country": "India", "timezone": "Asia/Kolkata", "currency": "INR",
        "company_name": name, "company_abbr": code[:5], "chart_of_accounts": "Standard",
        "fy_start_date": "2026-04-01", "fy_end_date": "2027-03-31", "setup_demo": 0})
    frappe.db.commit()
print("setup complete:", frappe.db.get_single_value("System Settings", "setup_complete"))

# 4. SSV Settings and wording
frappe.db.set_single_value("SSV Settings", {"principal_code": code, "principal_name": name, "hold_until_consent": 1})
from ssv_channel import partner_labels
n = partner_labels.apply("Dealer", "Customer")
frappe.db.commit()
print(f"SSV Settings: principal {code}, consent hold on; {n} labels now say Dealer / Customer")
frappe.destroy()
PY
cd ..

say "5. address"
if ! grep -q "hostname: $SITE" "$TUNNEL_CONFIG"; then
  tunnel=$(awk '/^tunnel:/{print $2}' "$TUNNEL_CONFIG")
  sudo cp -a "$TUNNEL_CONFIG" "$TUNNEL_CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
  # new site above the catch-all 404 rule
  sudo python3 - "$TUNNEL_CONFIG" "$SITE" <<'PY'
import sys
path, host = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
i = next(k for k, l in enumerate(lines) if "http_status:404" in l)
lines[i:i] = [f"  - hostname: {host}", "    service: http://localhost:80"]
open(path, "w").write("\n".join(lines) + "\n")
PY
  cloudflared tunnel --config "$TUNNEL_CONFIG" ingress validate
  cloudflared tunnel route dns "$tunnel" "$SITE"
  sudo systemctl restart cloudflared
fi

say "6. checks"
sleep 5
for host in "$SITE" "$EXISTING_HOST"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/api/method/ping")
  echo "$host -> HTTP $code"
done
echo
echo "Done. Next, in https://$SITE (log in as Administrator):"
echo "  - SSV Dealer > New for each dealer (its Tally stock group rule), then Actions > Show Agent Secret"
echo "  - give each dealer the agent package; they paste those lines into the agent's setup page"
