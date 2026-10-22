Gem::Specification.new do |s|
  s.name        = "sealpost"
  s.version     = "0.1.0"
  s.summary     = "Zero-dependency Ruby client for the self-hosted Sealpost email API"
  s.description = "Send email, schedule it, read logs and received mail, manage audiences and verify webhooks against a Sealpost server. Standard library only."
  s.authors     = ["Sagar Pinninti"]
  s.license     = "MIT"
  s.homepage    = "https://github.com/isagarpinninti/sealpost"
  s.required_ruby_version = ">= 2.6"
  s.files       = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  s.metadata    = { "source_code_uri" => "https://github.com/isagarpinninti/sealpost/tree/main/sdks/ruby" }
end
