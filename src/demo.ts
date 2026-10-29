export const DEMO_SCHEMA = `syntax = "pcl/1";

package fleet;

message ServiceConfig {
  string host = 1;
  int32 port = 2 [default = 8080];
  bool verbose = 3;
  string api_key = 4;
  LogLevel log_level = 5 [default = INFO];
  repeated string tags = 6;
  map<string, string> labels = 7;
  Tls tls = 8;
  oneof auth {
    string token = 9;
    string basic_user = 10;
  }
}

message Tls {
  required string cert = 1;
  required string key = 2;
  bool skip_verify = 3;
}

enum LogLevel {
  DEBUG = 0;
  INFO = 1;
  WARN = 2;
  ERROR = 3;
}
`;

export const DEMO_CONFIG = `{
  "host": "api.example.com",
  "port": 9090,
  "tags": ["edge", "prod"],
  "labels": { "team": "infra", "region": "us-east" },
  "tls": { "cert": "/etc/certs/api.pem", "key": "/etc/certs/api-key.pem" },
  "token": "tok_9f2c"
}`;

export const DEMO_ENV: Record<string, string> = {
  PCL_VERBOSE: "true",
  PCL_LOG_LEVEL: "WARN",
  PCL_TLS__SKIP_VERIFY: "false",
};

export const DEMO_OUTPUT = `Resolved config ($ = fleet.ServiceConfig):
{
  "host": "api.example.com",
  "port": 9090,
  "verbose": true,
  "api_key": "",
  "log_level": "WARN",
  "tags": ["edge","prod"],
  "labels": { "team": "infra", "region": "us-east" },
  "tls": { "cert": "/etc/certs/api.pem", "key": "/etc/certs/api-key.pem", "skip_verify": false },
  "token": "tok_9f2c"
}
Sources: file config.json (highest) > env PCL_* > schema defaults (lowest).`;
