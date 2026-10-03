app_name = "ssv_channel"
app_title = "SSV Channel"
app_publisher = "SSV Platform"
app_description = "Distributor secondary sales and stock visibility, fed by the SSV Tally connector agent"
app_email = "support@example.com"
app_license = "mit"

required_apps = ["erpnext"]

# Nothing here posts to the GL or the stock ledger: distributor data lives in
# the app's own non-accounting DocTypes (blueprint decision AD-1).

# Channel classification fields on Item (product line, category, size, ...)
after_install = "ssv_channel.setup.after_install"
after_migrate = "ssv_channel.setup.after_migrate"

scheduler_events = {
	# Stale distributors and negative stock, e-mailed to SSV Settings → Send Alerts To
	"daily": ["ssv_channel.alerts.send_daily_alerts"],
}
