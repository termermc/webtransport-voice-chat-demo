use anyhow::Context;
use anyhow::Result;
use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use serde::{Deserialize, Serialize};
use http::HttpServer;
use tracing::error;
use tracing::info;
use tracing::info_span;
use tracing::Instrument;
use webtransport::WebTransportServer;
use wtransport::tls::Sha256Digest;
use wtransport::tls::Sha256DigestFmt;
use wtransport::Identity;

use protobuf::system;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerConfig {
    cert_digest_base64: String,
    default_port: u16,
}

#[tokio::main]
async fn main() -> Result<()> {
    utils::init_logging();

    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"]).unwrap();
    let cert_digest = identity.certificate_chain().as_slice()[0].hash();

    let webtransport_server = WebTransportServer::new(identity)?;
    let http_server = HttpServer::new(&cert_digest, webtransport_server.local_port()).await?;

    info!(
        "Open the browser and go to: http://127.0.0.1:{}",
        http_server.local_port()
    );

    tokio::select! {
        result = http_server.serve() => {
            error!("HTTP server: {:?}", result);
        }
        result = webtransport_server.serve() => {
            error!("WebTransport server: {:?}", result);
        }
    }

    Ok(())
}

mod webtransport {
    use super::*;
    use std::time::Duration;
    use wtransport::endpoint::endpoint_side::Server;
    use wtransport::endpoint::IncomingSession;
    use wtransport::Endpoint;
    use wtransport::ServerConfig;

    pub struct WebTransportServer {
        endpoint: Endpoint<Server>,
    }

    impl WebTransportServer {
        pub fn new(identity: Identity) -> Result<Self> {
            let config = ServerConfig::builder()
                .with_bind_default(0)
                .with_identity(identity)
                .keep_alive_interval(Some(Duration::from_secs(3)))
                .build();

            let endpoint = Endpoint::server(config)?;

            Ok(Self { endpoint })
        }

        pub fn local_port(&self) -> u16 {
            self.endpoint.local_addr().unwrap().port()
        }

        pub async fn serve(self) -> Result<()> {
            info!("Server running on port {}", self.local_port());

            for id in 0.. {
                let incoming_session = self.endpoint.accept().await;

                tokio::spawn(
                    Self::handle_incoming_session(incoming_session)
                        .instrument(info_span!("Connection", id)),
                );
            }

            Ok(())
        }

        async fn handle_incoming_session(incoming_session: IncomingSession) {
            async fn handle_incoming_session_impl(incoming_session: IncomingSession) -> Result<()> {
                let mut buffer = vec![0; 65536].into_boxed_slice();

                info!("Waiting for session request...");

                let session_request = incoming_session.await?;

                info!(
                    "New session: Authority: '{}', Path: '{}'",
                    session_request.authority(),
                    session_request.path()
                );

                let connection = session_request.accept().await?;

                let session_id: u64 = rand::random();

                info!("Waiting for data from client...");

                loop {
                    tokio::select! {
                        stream = connection.accept_bi() => {
                            let mut stream = stream?;
                            info!("Accepted BI stream");

                            let bytes_read = match stream.1.read(&mut buffer).await? {
                                Some(bytes_read) => bytes_read,
                                None => continue,
                            };

                            let str_data = std::str::from_utf8(&buffer[..bytes_read])?;

                            info!("Received (bi) '{str_data}' from client");

                            let ack_str = String::from("ACK".to_owned() + &str_data);
                            stream.0.write_all(ack_str.as_bytes()).await?;
                        }
                        stream = connection.accept_uni() => {
                            let mut stream = stream?;
                            info!("Accepted UNI stream");

                            let bytes_read = match stream.read(&mut buffer).await? {
                                Some(bytes_read) => bytes_read,
                                None => continue,
                            };

                            let str_data = std::str::from_utf8(&buffer[..bytes_read])?;

                            info!("Received (uni) '{str_data}' from client");

                            let mut stream = connection.open_uni().await?.await?;
                            let ack_str = String::from("ACK".to_owned() + &str_data);
                            stream.write_all(ack_str.as_bytes()).await?;
                        }
                        dgram = connection.receive_datagram() => {
                            let dgram = dgram?;
                            let str_data = std::str::from_utf8(&dgram)?;

                            info!("Received (dgram) '{str_data}' from client (session_id: {session_id})");

                            let ack_str = String::from("ACK".to_owned() + &str_data);
                            connection.send_datagram(ack_str.as_bytes())?;
                        }
                    }
                }
            }

            let result = handle_incoming_session_impl(incoming_session).await;
            info!("Result: {:?}", result);
        }
    }
}

mod http {
    use super::*;
    use axum::http::header::CONTENT_TYPE;
    use axum::response::Html;
    use axum::routing::get;
    use axum::serve;
    use axum::serve::Serve;
    use axum::Router;
    use std::net::Ipv4Addr;
    use std::net::SocketAddr;
    use axum::http::Method;
    use tokio::net::TcpListener;

    pub struct HttpServer {
        serve: Serve<TcpListener, Router, Router>,
        local_port: u16,
    }

    impl HttpServer {
        const PORT: u16 = 8080;

        pub async fn new(cert_digest: &Sha256Digest, webtransport_port: u16) -> Result<Self> {
            let router = Self::build_router(cert_digest, webtransport_port);

            let listener =
                TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), Self::PORT))
                    .await
                    .context("Cannot bind TCP listener for HTTP server")?;

            let local_port = listener
                .local_addr()
                .context("Cannot get local port")?
                .port();

            Ok(HttpServer {
                serve: serve(listener, router),
                local_port,
            })
        }

        pub fn local_port(&self) -> u16 {
            self.local_port
        }

        pub async fn serve(self) -> Result<()> {
            info!("Server running on port {}", self.local_port());

            self.serve.await.context("HTTP server error")?;

            Ok(())
        }

        fn build_router(cert_digest: &Sha256Digest, webtransport_port: u16) -> Router {
            let config_json = serde_json::to_string(&ServerConfig {
                cert_digest_base64: BASE64_STANDARD.encode(cert_digest.as_ref()),
                default_port: webtransport_port,
            })
            .expect("failed to serialize server config");

            // Create CORS middleware
            let cors = tower_http::cors::CorsLayer::new()
                .allow_methods([Method::GET])
                .allow_origin(tower_http::cors::Any);

            Router::new()
                .route("/config.json", get(config_json))
                .layer(cors)
        }
    }
}

mod utils {
    use tracing_subscriber::filter::LevelFilter;
    use tracing_subscriber::EnvFilter;

    pub fn init_logging() {
        let env_filter = EnvFilter::builder()
            .with_default_directive(LevelFilter::INFO.into())
            .from_env_lossy();

        tracing_subscriber::fmt()
            .with_target(true)
            .with_level(true)
            .with_env_filter(env_filter)
            .init();
    }
}
