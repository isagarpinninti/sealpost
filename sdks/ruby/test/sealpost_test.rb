require "minitest/autorun"
require "socket"
require "json"
require "time"
require_relative "../lib/sealpost"

# A tiny HTTP server on a loopback socket, so the tests need nothing beyond the standard library.
class FakeServer
  attr_reader :port, :seen

  def initialize(&handler)
    @handler = handler
    @seen = []
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @thread = Thread.new do
      loop do
        client = @server.accept
        Thread.new(client) { |c| serve(c) }
      end
    rescue IOError
      nil
    end
  end

  def url
    "http://127.0.0.1:#{@port}"
  end

  def stop
    @server.close
  end

  private

  def serve(c)
    request_line = c.gets.to_s
    method, path, = request_line.split(" ")
    headers = {}
    while (line = c.gets) && line != "\r\n"
      k, v = line.split(":", 2)
      headers[k.downcase] = v.to_s.strip
    end
    body = headers["content-length"] ? c.read(headers["content-length"].to_i) : ""
    @seen << { method: method, path: path, headers: headers, body: body }
    status, json, extra = @handler.call(path, method, body)
    payload = json.is_a?(String) ? json : JSON.generate(json)
    head = "HTTP/1.1 #{status} X\r\nContent-Type: application/json\r\nContent-Length: #{payload.bytesize}\r\nConnection: close\r\n"
    (extra || {}).each { |k, v| head << "#{k}: #{v}\r\n" }
    c.write(head + "\r\n" + payload)
  ensure
    c.close
  end
end

class SealpostTest < Minitest::Test
  # Starts a fake server for the block's duration and yields it with a client pointed at it.
  def with_server(handler)
    server = FakeServer.new(&handler)
    yield server, Sealpost::Client.new(api_key: "evk_t", base_url: server.url, timeout: 2)
  ensure
    server&.stop
  end

  def test_send_maps_body_headers_and_result
    handler = proc { [201, { ok: true, id: "em_1", status: "delivered" }, { "Idempotent-Replayed" => "true" }] }
    with_server(handler) do |s, mail|
      r = mail.emails.deliver(template: "t", to: "a@b.co", variables: { x: 1 }, auto_fill: true, idempotency_key: "order-1", scheduled_at: Time.utc(2030, 1, 1))
      assert r.ok?
      assert_equal "em_1", r.data["id"]
      assert r.replayed?
      seen = s.seen.first
      assert_equal "Bearer evk_t", seen[:headers]["authorization"]
      assert_equal "order-1", seen[:headers]["idempotency-key"]
      assert_equal({ "templateId" => "t", "to" => "a@b.co", "variables" => { "x" => 1 }, "autoFill" => true, "scheduledAt" => "2030-01-01T00:00:00Z" }, JSON.parse(seen[:body]))
    end
  end

  def test_blocked_send_is_an_error_not_an_exception
    handler = proc { [403, { ok: false, error: "Blocked", code: "preflight_blocked", requestId: "req_1", preflight: { gate: "BLOCKED" } }] }
    with_server(handler) do |_s, mail|
      r = mail.emails.deliver(template: "t", to: "a@b.co")
      refute r.ok?
      assert_nil r.data
      assert_equal [403, "preflight_blocked", "req_1", "BLOCKED"], [r.error.status, r.error.code, r.error.request_id, r.error.preflight["gate"]]
      assert_raises(Sealpost::SealpostException) { r.unwrap }
    end
  end

  def test_network_failure_is_status_zero
    r = Sealpost::Client.new(api_key: "k", base_url: "http://127.0.0.1:1", timeout: 1).stats
    assert_equal 0, r.error.status
  end

  def test_lists_encode_queries_and_resources_map_paths
    handler = proc do |path, _method, _body|
      if path.start_with?("/api/suppressions")
        [200, { suppressions: [] }]
      else
        [200, { data: [], hasMore: false, nextCursor: nil, broadcast: { id: "brd_1" }, audience: { id: "aud_1" }, url: "https://m/u/x", scheduled: { id: "sch_1" } }]
      end
    end
    with_server(handler) do |s, mail|
      mail.emails.list(status: "bounced", tag: "campaign:welcome", limit: 5, before: "em_9")
      assert_equal "/api/emails?status=bounced&tag=campaign%3Awelcome&limit=5&before=em_9", s.seen.last[:path]
      mail.inbound.list(from: "ada@", kind: "bounce")
      assert_equal "/api/inbound?from=ada%40&kind=bounce", s.seen.last[:path]
      assert_equal "aud_1", mail.audiences.create("L").data["id"]
      assert_equal "brd_1", mail.broadcasts.create(name: "n", audience_id: "aud_1", template: "t", rate_per_minute: 120).data["id"]
      assert_equal({ "name" => "n", "audienceId" => "aud_1", "templateId" => "t", "ratePerMinute" => 120 }, JSON.parse(s.seen.last[:body]))
      mail.suppressions.remove("a+b@x.io")
      assert_equal ["DELETE", "/api/suppressions?email=a%2Bb%40x.io"], [s.seen.last[:method], s.seen.last[:path]]
      assert_equal "https://m/u/x", mail.unsubscribe_link("a@b.co").data
      assert_equal "sch_1", mail.scheduled.cancel("sch_1").data["id"]
    end
  end

  def test_download_returns_bytes_and_filename
    handler = proc { [200, "BIN\x00".b, { "Content-Disposition" => "attachment; filename=\"a.png\"; filename*=UTF-8''%E2%82%AC%20a.png" }] }
    with_server(handler) do |_s, mail|
      r = mail.inbound.attachment("in_1", 0)
      assert_equal "BIN\x00".b, r.data[:bytes].b
      assert_equal "\u20ac a.png", r.data[:filename]
    end
  end

  def test_webhook_verification
    body = JSON.generate({ id: "evt_1", type: "email.delivered" })
    t = 1_700_000_000
    header = "t=#{t},v1=#{OpenSSL::HMAC.hexdigest("SHA256", "whsec", "#{t}.#{body}")}"
    assert_equal [true, nil], Sealpost::Webhooks.verify("whsec", body, header, now: t + 5)
    assert_equal [false, :mismatch], Sealpost::Webhooks.verify("whsec", body + " ", header, now: t + 5)
    assert_equal [false, :stale], Sealpost::Webhooks.verify("whsec", body, header, now: t + 9999)
    assert_equal [false, :malformed], Sealpost::Webhooks.verify("whsec", body, "nope")
    assert_equal [true, nil], Sealpost::Webhooks.verify("whsec", body, Sealpost::Webhooks.sign("whsec", body))
  end

  def test_requires_api_key
    assert_raises(ArgumentError) { Sealpost::Client.new(api_key: "") }
  end
end
