import {Component, createSignal, For} from "solid-js";
import {ServerConfig} from "./App";

import {base64ToArrayBuffer} from "./util";

type LogEntry = { text: string; severity: "info" | "error" };

export const Interface: Component<{ config: ServerConfig }> = ({ config }) => {
    const [url, setUrl] = createSignal(
        `https://localhost:${config.default_port}/`
    );
    const [connected, setConnected] = createSignal(false);
    const [sendType, setSendType] = createSignal<"datagram" | "unidi" | "bidi">(
        "datagram"
    );
    const [data, setData] = createSignal("");
    const [log, setLog] = createSignal<LogEntry[]>([]);
    let transportRef: WebTransport;
    let datagramWriterRef: WritableStreamDefaultWriter;
    let streamNumberRef: number = 1;

    // Helper to add to event log
    const addToEventLog = (text: string, severity: "info" | "error" = "info") => {
        setLog((prev) => [...prev, { text, severity }]);
        // Optionally, scroll to bottom (handled in useEffect if desired)
    };

    // Connect handler
    const connect = async () => {
        try {
            const HASH = base64ToArrayBuffer(config.cert_digest_base64);
            const transport = new WebTransport(url(), {
                serverCertificateHashes: [
                    { algorithm: "sha-256", value: HASH },
                ],
            });
            addToEventLog("Initiating connection...");
            await transport.ready;
            addToEventLog("Connection ready.");

            transport.closed
                .then(() => {
                    addToEventLog("Connection closed normally.");
                })
                .catch(() => {
                    addToEventLog("Connection closed abruptly.", "error");
                });

            transportRef = transport;
            streamNumberRef = 1;

            try {
                datagramWriterRef = transport.datagrams.writable.getWriter();
                addToEventLog("Datagram writer ready.");
            } catch (e: any) {
                addToEventLog("Sending datagrams not supported: " + e, "error");
                return;
            }

            readDatagrams(transport);
            acceptUnidirectionalStreams(transport);

            setConnected(true);
        } catch (e: any) {
            addToEventLog("Failed to create connection object. " + e, "error");
        }
    };

    // Send data handler
    const sendData = async () => {
        const encoder = new TextEncoder();
        const rawData = data();
        const encoded = encoder.encode(rawData);
        const transport = transportRef;
        try {
            switch (sendType()) {
                case "datagram":
                    await datagramWriterRef.write(encoded);
                    addToEventLog("Sent datagram: " + rawData);
                    break;
                case "unidi": {
                    const stream = await transport.createUnidirectionalStream();
                    const writer = stream.getWriter();
                    await writer.write(encoded);
                    await writer.close();
                    addToEventLog("Sent a unidirectional stream with data: " + rawData);
                    break;
                }
                case "bidi": {
                    const stream = await transport.createBidirectionalStream();
                    const number = streamNumberRef++;
                    await readFromIncomingStream(stream.readable, number);

                    const writer = stream.writable.getWriter();
                    await writer.write(encoded);
                    await writer.close();
                    addToEventLog(
                        `Opened bidirectional stream #${number} with data: ${rawData}`
                    );
                    break;
                }
            }
        } catch (e: any) {
            addToEventLog("Error while sending data: " + e, "error");
        }
    };

    // Read datagrams
    const readDatagrams = async (transport: any) => {
        try {
            const reader = transport.datagrams.readable.getReader();
            addToEventLog("Datagram reader ready.");
            const decoder = new TextDecoder("utf-8");
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    addToEventLog("Done reading datagrams!");
                    return;
                }
                const data = decoder.decode(value);
                addToEventLog("Datagram received: " + data);
            }
        } catch (e: any) {
            addToEventLog("Error while reading datagrams: " + e, "error");
        }
    };

    // Accept unidirectional streams
    const acceptUnidirectionalStreams = async (transport: any) => {
        const reader = transport.incomingUnidirectionalStreams.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    addToEventLog("Done accepting unidirectional streams!");
                    return;
                }
                const stream = value;
                const number = streamNumberRef++;
                addToEventLog(`New incoming unidirectional stream #${number}`);
                readFromIncomingStream(stream, number);
            }
        } catch (e: any) {
            addToEventLog("Error while accepting streams: " + e, "error");
        }
    };

    // Read from incoming stream
    const readFromIncomingStream = async (stream: any, number: number) => {
        try {
            const decoder = new (window as any).TextDecoderStream("utf-8");
            const reader = stream.pipeThrough(decoder).getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    addToEventLog(`Stream #${number} closed`);
                    return;
                }
                addToEventLog(`Received data on stream #${number}: ${value}`);
            }
        } catch (e: any) {
            addToEventLog(
                `Error while reading from stream #${number}: ${e}`,
                "error"
            );
            addToEventLog("    " + e.message, "error");
        }
    };

    return (
        <div class="App">
            <h1>WTransport Example</h1>

            <div>
                <h2>Establish WebTransport connection</h2>
                <div class="input-line">
                    <label for="url">URL:</label>
                    <input
                        type="text"
                        name="url"
                        id="url"
                        value={url()}
                        onChange={(e) => setUrl(e.target.value)}
                        disabled={connected()}
                    />
                    <input
                        type="button"
                        id="connect"
                        value="Connect"
                        onClick={connect}
                        disabled={connected()}
                    />
                </div>
            </div>

            <div>
                <h2>Send data over WebTransport</h2>
                <form
                    name="sending"
                    onSubmit={(e) => {
                        e.preventDefault();
                        sendData();
                    }}
                >
          <textarea
              name="data"
              id="data"
              value={data()}
              onChange={(e) => setData(e.target.value)}
          />
                    <div>
                        <input
                            type="radio"
                            name="sendtype"
                            value="datagram"
                            id="datagram"
                            checked={sendType() === "datagram"}
                            onChange={() => setSendType("datagram")}
                        />
                        <label for="datagram">Send a datagram</label>
                    </div>
                    <div>
                        <input
                            type="radio"
                            name="sendtype"
                            value="unidi"
                            id="unidi-stream"
                            checked={sendType() === "unidi"}
                            onChange={() => setSendType("unidi")}
                        />
                        <label for="unidi-stream">Open a unidirectional stream</label>
                    </div>
                    <div>
                        <input
                            type="radio"
                            name="sendtype"
                            value="bidi"
                            id="bidi-stream"
                            checked={sendType() === "bidi"}
                            onChange={() => setSendType("bidi")}
                        />
                        <label for="bidi-stream">Open a bidirectional stream</label>
                    </div>
                    <input
                        type="submit"
                        id="send"
                        name="send"
                        value="Send data"
                        disabled={!connected}
                    />
                </form>
            </div>

            <div>
                <h2>Event log</h2>
                <ul id="event-log">
                    <For each={log()} fallback={<li>Loading...</li>}>
                        {(entry, idx) => (
                            <li
                                class={entry.severity === "error" ? "log-error" : ""}
                            >
                                {entry.text}
                            </li>
                        )}
                    </For>
                </ul>
            </div>
        </div>
    );
};