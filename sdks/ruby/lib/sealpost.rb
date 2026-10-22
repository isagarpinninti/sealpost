require "json"
require "net/http"
require "openssl"
require "uri"
require_relative "sealpost/webhooks"
require_relative "sealpost/client"

# Ruby client for the Sealpost API. Standard library only.
#
#   mail = Sealpost::Client.new(api_key: ENV["SEALPOST_KEY"], base_url: "https://mail.example.com")
#   result = mail.emails.deliver(template: "magic_link_otp_verification", to: "user@example.org",
#                                variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" })
#   if result.error&.code == "preflight_blocked"
#     puts result.error.preflight["checks"]   # nothing was sent
#   end
module Sealpost
  VERSION = "0.1.0"
end
