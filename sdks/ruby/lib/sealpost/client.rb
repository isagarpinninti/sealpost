module Sealpost
  # One of data or error is set. Nothing raises unless you call #unwrap.
  class Error
    attr_reader :status, :code, :message, :preflight, :request_id

    def initialize(status:, message:, code: nil, preflight: nil, request_id: nil)
      @status = status # HTTP status, or 0 for a network failure or timeout
      @message = message
      @code = code
      @preflight = preflight
      @request_id = request_id
    end

    def to_s
      "#{message} (#{status})#{code ? " [#{code}]" : ""}"
    end
  end

  class SealpostException < StandardError
    attr_reader :error

    def initialize(error)
      super(error.to_s)
      @error = error
    end
  end

  class Result
    attr_reader :data, :error, :headers

    def initialize(data: nil, error: nil, headers: {})
      @data = data
      @error = error
      @headers = headers
    end

    def ok?
      @error.nil?
    end

    # True when the server replayed an earlier response for the same idempotency_key.
    def replayed?
      @headers["idempotent-replayed"] == "true"
    end

    def unwrap
      raise SealpostException, @error if @error
      @data
    end
  end

  class Resource
    def initialize(client)
      @c = client
    end

    private

    def q(value)
      URI.encode_www_form_component(value.to_s).gsub("+", "%20")
    end

    def query(params)
      pairs = params.reject { |_, v| v.nil? }
      pairs.empty? ? "" : "?" + URI.encode_www_form(pairs)
    end
  end

  class Emails < Resource
    WIRE = { auto_fill: "autoFill", include_mime: "includeMime", in_reply_to: "inReplyTo", scheduled_at: "scheduledAt" }.freeze

    # Send one email. result.error.code == "preflight_blocked" means nothing was sent.
    # Options: variables, domain, cc, bcc, auto_fill, attachments, tags, metadata, in_reply_to, scheduled_at (ISO 8601 or Time),
    # idempotency_key (same key + body within 24 h returns the original result; see result.replayed?).
    def deliver(template:, to:, idempotency_key: nil, **opts)
      body = { "templateId" => template, "to" => to }
      opts.each do |k, v|
        next if v.nil?
        v = v.utc.iso8601 if v.respond_to?(:utc) && k == :scheduled_at
        body[WIRE.fetch(k, k.to_s)] = v
      end
      @c.request(:post, "/api/send", body, nil, idempotency_key ? { "Idempotency-Key" => idempotency_key } : {})
    end
    alias send_email deliver

    def batch(items)
      emails = items.map do |i|
        i = i.dup
        b = { "templateId" => i.delete(:template), "to" => i.delete(:to) }
        i.each { |k, v| b[WIRE.fetch(k, k.to_s)] = v unless v.nil? }
        b
      end
      @c.request(:post, "/api/send/batch", { "emails" => emails })
    end

    def preview(template:, to: [], **opts)
      body = { "templateId" => template, "to" => to }
      opts.each { |k, v| body[WIRE.fetch(k, k.to_s)] = v unless v.nil? }
      @c.request(:post, "/api/compile", body)
    end

    def get(id)
      @c.request(:get, "/api/emails/#{q(id)}")
    end

    # Newest first. Page with before: page["nextCursor"].
    def list(status: nil, to: nil, template: nil, domain: nil, tag: nil, since: nil, until_: nil, limit: nil, before: nil)
      @c.request(:get, "/api/emails" + query(status: status, to: to, template: template, domain: domain, tag: tag, since: since, until: until_, limit: limit, before: before))
    end
  end

  class Inbound < Resource
    # Received mail. html bodies are untrusted: show them only in a sandboxed frame with remote content blocked.
    def list(from: nil, to: nil, q: nil, kind: nil, since: nil, until_: nil, limit: nil, before: nil)
      @c.request(:get, "/api/inbound" + query(from: from, to: to, q: q, kind: kind, since: since, until: until_, limit: limit, before: before))
    end

    def get(id)
      @c.request(:get, "/api/inbound/#{q(id)}")
    end

    def raw(id)
      @c.request_bytes("/api/inbound/#{q(id)}/raw")
    end

    def attachment(id, index)
      @c.request_bytes("/api/inbound/#{q(id)}/attachments/#{Integer(index)}")
    end

    def delete(id)
      @c.request(:delete, "/api/inbound/#{q(id)}")
    end
  end

  class Audiences < Resource
    def create(name)
      @c.request(:post, "/api/audiences", { "name" => name }, ->(j) { j["audience"] })
    end

    def list
      @c.request(:get, "/api/audiences", nil, ->(j) { j["audiences"] || [] })
    end

    # contacts: [{ email:, name:, variables: {} }], up to 10,000 per call.
    def add_contacts(id, contacts)
      @c.request(:post, "/api/audiences/#{q(id)}/contacts", { "contacts" => contacts })
    end

    def delete(id)
      @c.request(:delete, "/api/audiences/#{q(id)}")
    end
  end

  class Broadcasts < Resource
    def create(name:, audience_id:, template:, domain: nil, variables: nil, scheduled_at: nil, rate_per_minute: nil)
      body = { "name" => name, "audienceId" => audience_id, "templateId" => template }
      body["domain"] = domain if domain
      body["variables"] = variables if variables
      body["scheduledAtIso"] = scheduled_at.respond_to?(:utc) ? scheduled_at.utc.iso8601 : scheduled_at if scheduled_at
      body["ratePerMinute"] = rate_per_minute if rate_per_minute
      @c.request(:post, "/api/broadcasts", body, ->(j) { j["broadcast"] })
    end

    def list
      @c.request(:get, "/api/broadcasts", nil, ->(j) { j["broadcasts"] || [] })
    end

    def get(id)
      @c.request(:get, "/api/broadcasts/#{q(id)}")
    end

    def cancel(id)
      @c.request(:post, "/api/broadcasts/#{q(id)}/cancel", {}, ->(j) { j["broadcast"] })
    end
  end

  class Scheduled < Resource
    def list
      @c.request(:get, "/api/scheduled", nil, ->(j) { j["scheduled"] || [] })
    end

    def cancel(id)
      @c.request(:delete, "/api/scheduled/#{q(id)}", nil, ->(j) { j["scheduled"] })
    end
  end

  class Suppressions < Resource
    def list
      @c.request(:get, "/api/suppressions", nil, ->(j) { j["suppressions"] || [] })
    end

    def add(email, reason: "unsubscribed", detail: nil)
      @c.request(:post, "/api/suppressions", { "email" => email, "reason" => reason, "detail" => detail }.compact, ->(j) { j["suppressions"] || [] })
    end

    def remove(email)
      @c.request(:delete, "/api/suppressions?email=#{q(email)}", nil, ->(j) { j["suppressions"] || [] })
    end
  end

  class Domains < Resource
    def list
      @c.request(:get, "/api/domains", nil, ->(j) { j["domains"] || [] })
    end

    # Live SPF / DKIM / DMARC lookup.
    def check(domain)
      @c.request(:get, "/api/domains/#{q(domain)}/check")
    end
  end

  class Client
    attr_reader :emails, :inbound, :audiences, :broadcasts, :scheduled, :suppressions, :domains

    def initialize(api_key:, base_url: "http://127.0.0.1:4320", timeout: 30)
      raise ArgumentError, "Sealpost: api_key is required" if api_key.nil? || api_key.empty?
      @key = api_key
      @base = base_url.sub(%r{/+\z}, "")
      @timeout = timeout
      @emails = Emails.new(self)
      @inbound = Inbound.new(self)
      @audiences = Audiences.new(self)
      @broadcasts = Broadcasts.new(self)
      @scheduled = Scheduled.new(self)
      @suppressions = Suppressions.new(self)
      @domains = Domains.new(self)
    end

    def stats
      request(:get, "/api/stats")
    end

    # A hosted one-click unsubscribe URL (needs unsubscribe.hosted and a trackingBaseUrl on the server).
    def unsubscribe_link(email, domain: nil)
      request(:post, "/api/unsubscribe-link", { "email" => email, "domain" => domain }.compact, ->(j) { j["url"] })
    end

    def verify_receipt(token, inbox_id: nil)
      request(:post, "/api/verify", { "token" => token, "inboxId" => inbox_id }.compact)
    end

    # JSON request. pick: optional lambda that extracts the data from the parsed body.
    def request(method, path, body = nil, pick = nil, extra_headers = {})
      res = perform(method, path, body ? JSON.generate(body) : nil, extra_headers)
      parsed = parse(res.body)
      headers = {}
      res.each_header { |k, v| headers[k.downcase] = v }
      unless res.code.to_i.between?(200, 299)
        return Result.new(error: Error.new(status: res.code.to_i, message: (parsed["error"] || "HTTP #{res.code}").to_s, code: parsed["code"], preflight: parsed["preflight"], request_id: parsed["requestId"] || headers["x-request-id"]), headers: headers)
      end
      Result.new(data: pick ? pick.call(parsed) : parsed, headers: headers)
    rescue Timeout::Error, SystemCallError, SocketError, OpenSSL::SSL::SSLError, EOFError, Net::OpenTimeout, Net::ReadTimeout => e
      Result.new(error: Error.new(status: 0, message: e.message))
    end

    # Binary download: { bytes:, content_type:, filename: }.
    def request_bytes(path)
      res = perform(:get, path, nil, {})
      unless res.code.to_i.between?(200, 299)
        parsed = parse(res.body)
        return Result.new(error: Error.new(status: res.code.to_i, message: (parsed["error"] || "HTTP #{res.code}").to_s, code: parsed["code"], request_id: parsed["requestId"] || res["x-request-id"]))
      end
      encoded = res["content-disposition"].to_s[/filename\*=UTF-8''([^;]+)/i, 1]
      Result.new(data: { bytes: res.body, content_type: res["content-type"], filename: encoded && URI.decode_www_form_component(encoded) })
    rescue Timeout::Error, SystemCallError, SocketError, OpenSSL::SSL::SSLError, EOFError, Net::OpenTimeout, Net::ReadTimeout => e
      Result.new(error: Error.new(status: 0, message: e.message))
    end

    private

    def perform(method, path, json, extra_headers)
      uri = URI.parse(@base + path)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = @timeout
      http.read_timeout = @timeout
      klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, delete: Net::HTTP::Delete }.fetch(method)
      req = klass.new(uri.request_uri)
      req["Authorization"] = "Bearer #{@key}"
      req["Accept"] = "application/json"
      req["User-Agent"] = "sealpost-ruby/#{Sealpost::VERSION}"
      extra_headers.each { |k, v| req[k] = v }
      if json
        req["Content-Type"] = "application/json"
        req.body = json
      end
      http.request(req)
    end

    def parse(raw)
      v = JSON.parse(raw.to_s)
      v.is_a?(Hash) ? v : { "_" => v }
    rescue JSON::ParserError
      {}
    end
  end
end
