module Sealpost
  # Verification of Sealpost outbound webhooks. The Sealpost-Signature header is "t=<unix seconds>,v1=<hex>" where
  # v1 = HMAC-SHA256(secret, "<t>.<raw body>"). Always verify against the raw body.
  module Webhooks
    SIGNATURE_HEADER = "Sealpost-Signature".freeze
    DEFAULT_TOLERANCE = 300

    # Returns [ok, reason]; reason is :malformed, :stale or :mismatch when not ok.
    def self.verify(secret, raw_body, header, tolerance: DEFAULT_TOLERANCE, now: Time.now.to_i)
      parts = {}
      header.to_s.split(",").each do |piece|
        key, _, value = piece.partition("=")
        parts[key.strip] = value.strip unless value.empty?
      end
      t = Integer(parts["t"], 10) rescue nil
      v1 = parts["v1"].to_s
      return [false, :malformed] if t.nil? || v1 !~ /\A[0-9a-f]{64}\z/
      return [false, :stale] if (now - t).abs > tolerance

      expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{t}.#{raw_body}")
      secure_compare(expected, v1) ? [true, nil] : [false, :mismatch]
    end

    def self.sign(secret, raw_body, timestamp = Time.now.to_i)
      "t=#{timestamp},v1=#{OpenSSL::HMAC.hexdigest("SHA256", secret, "#{timestamp}.#{raw_body}")}"
    end

    def self.secure_compare(a, b)
      return false unless a.bytesize == b.bytesize
      result = 0
      a.bytes.zip(b.bytes) { |x, y| result |= x ^ y }
      result.zero?
    end
  end
end
