import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
    AuthRequest,
    AuthRequestSchema,
    AuthResponseError,
    AuthResponseError_Type, AuthResponseErrorSchema,
    AuthResponseSuccess, AuthResponseSuccessSchema,
    JoinRoomRequest,
    JoinRoomRequestSchema,
    JoinRoomResponse, JoinRoomResponseSchema,
    PacketType
} from "../../../protobuf/src/packet_pb";
import {RoomUser, RoomUserSchema} from "../../../protobuf/src/common_pb";
import { base64ToArrayBuffer } from "../util";

type PacketTypeToMessage = {
    [PacketType.AUTH_REQUEST]: AuthRequest,
    [PacketType.JOIN_ROOM_REQUEST]: JoinRoomRequest,
}

export type VoiceChatClientConfig = {
    url: string;
    certDigestBase64: string;
};

export type VoiceChatClientEvents = {
    onConnected?: () => void;
    onConnectionError?: (error: Error) => void;
    onConnectionClosed?: () => void;
    onAuthSuccess?: (sessionId: bigint) => void;
    onAuthError?: (errorType: AuthResponseError_Type) => void;
    onJoinedRoom?: (users: RoomUser[]) => void;
    onUserJoined?: (user: RoomUser) => void;
    onUserLeft?: (sessionId: bigint) => void;
    onVoiceData?: (sessionId: bigint, data: Uint8Array) => void;
};

export class VoiceChatClient {
    wt: WebTransport;
    private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private sessionId: bigint | null = null;
    private username: string | null = null;
    private currentRoomKey: string | null = null;
    private events: VoiceChatClientEvents = {};
    private connected: boolean = false;

    constructor(config: VoiceChatClientConfig, events: VoiceChatClientEvents = {}) {
        const certHash = base64ToArrayBuffer(config.certDigestBase64);
        this.wt = new WebTransport(config.url, {
            serverCertificateHashes: [
                { algorithm: "sha-256", value: certHash },
            ],
        });
        this.events = events;
    }

    /**
     * Initializes the WebTransport connection
     */
    async connect(): Promise<void> {
        try {
            // Wait for the connection to be established
            await this.wt.ready;
            this.connected = true;

            // Set up connection closed handler
            this.wt.closed
                .then(() => {
                    this.connected = false;
                    if (this.events.onConnectionClosed) {
                        this.events.onConnectionClosed();
                    }
                })
                .catch((error) => {
                    this.connected = false;
                    if (this.events.onConnectionError) {
                        this.events.onConnectionError(new Error(`Connection closed abruptly: ${error}`));
                    }
                });

            // Set up datagram writer
            this.datagramWriter = this.wt.datagrams.writable.getWriter();

            // Start reading datagrams
            this.readDatagrams();

            // Start accepting unidirectional streams
            this.acceptUnidirectionalStreams();

            // Start accepting bidirectional streams
            this.acceptBidirectionalStreams();

            if (this.events.onConnected) {
                this.events.onConnected();
            }
        } catch (error) {
            this.connected = false;
            if (this.events.onConnectionError) {
                this.events.onConnectionError(new Error(`Failed to establish connection: ${error}`));
            }
            throw error;
        }
    }

    /**
     * Authenticates with the server using the provided username
     * @param username The username to authenticate with
     */
    async authenticate(username: string): Promise<void> {
        if (!this.connected) {
            throw new Error("Not connected to server");
        }

        this.username = username;

        // Create auth request message
        const authRequest = create(AuthRequestSchema, {
            username: username,
            token: "" // Unused for now as per the proto definition
        });

        // Send auth request
        await this.sendProtobufMessage(PacketType.AUTH_REQUEST, authRequest);
    }

    /**
     * Joins a voice chat room
     * @param roomKey The key of the room to join
     */
    async joinRoom(roomKey: string): Promise<void> {
        if (!this.connected) {
            throw new Error("Not connected to server");
        }

        if (!this.sessionId) {
            throw new Error("Not authenticated");
        }

        this.currentRoomKey = roomKey;

        // Create join room request message
        const joinRoomRequest = create(JoinRoomRequestSchema, {
            roomKey: roomKey
        });

        // Send join room request
        await this.sendProtobufMessage(PacketType.JOIN_ROOM_REQUEST, joinRoomRequest);
    }

    /**
     * Leaves the current voice chat room
     */
    async leaveRoom(): Promise<void> {
        if (!this.connected) {
            throw new Error("Not connected to server");
        }

        if (!this.sessionId) {
            throw new Error("Not authenticated");
        }

        if (!this.currentRoomKey) {
            throw new Error("Not in a room");
        }

        // TODO: Implement leave room protocol if needed
        // For now, we'll just clear the current room key
        this.currentRoomKey = null;
    }

    /**
     * Sends voice data to the current room
     * @param data The voice data to send
     */
    async sendVoiceData(data: Uint8Array): Promise<void> {
        if (!this.connected) {
            throw new Error("Not connected to server");
        }

        if (!this.sessionId) {
            throw new Error("Not authenticated");
        }

        if (!this.currentRoomKey) {
            throw new Error("Not in a room");
        }

        if (!this.datagramWriter) {
            throw new Error("Datagram writer not available");
        }

        // For voice data, we'll use datagrams for efficiency
        // We'll prepend a byte to indicate this is voice data
        const voiceDataPacket = new Uint8Array(data.length + 1);
        voiceDataPacket[0] = 0xFF; // Using 0xFF to indicate voice data
        voiceDataPacket.set(data, 1);

        await this.datagramWriter.write(voiceDataPacket);
    }

    /**
     * Closes the WebTransport connection
     */
    async close(): Promise<void> {
        if (this.datagramWriter) {
            await this.datagramWriter.close();
            this.datagramWriter = null;
        }

        this.wt.close();
        this.connected = false;
        this.sessionId = null;
        this.username = null;
        this.currentRoomKey = null;
    }

    /**
     * Reads datagrams from the server
     */
    private async readDatagrams(): Promise<void> {
        try {
            const reader = this.wt.datagrams.readable.getReader();

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }

                // Process the datagram
                this.processDatagramData(value);
            }
        } catch (error) {
            if (this.events.onConnectionError) {
                this.events.onConnectionError(new Error(`Error reading datagrams: ${error}`));
            }
        }
    }

    /**
     * Processes datagram data
     * @param data The datagram data
     */
    private processDatagramData(data: Uint8Array): void {
        // Check if this is voice data (first byte is 0xFF)
        if (data.length > 0 && data[0] === 0xFF) {
            // Extract the voice data (everything after the first byte)
            const voiceData = data.slice(1);

            // Extract the session ID from the voice data (first 8 bytes)
            if (voiceData.length >= 8) {
                const sessionIdBytes = voiceData.slice(0, 8);
                const sessionId = this.bytesToBigInt(sessionIdBytes);
                const actualVoiceData = voiceData.slice(8);

                if (this.events.onVoiceData) {
                    this.events.onVoiceData(sessionId, actualVoiceData);
                }
            }
        } else {
            // This is a protobuf message
            this.processProtobufData(data);
        }
    }

    /**
     * Accepts unidirectional streams from the server
     */
    private async acceptUnidirectionalStreams(): Promise<void> {
        try {
            const reader = this.wt.incomingUnidirectionalStreams.getReader();

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }

                // Process the stream
                this.readFromStream(value);
            }
        } catch (error) {
            if (this.events.onConnectionError) {
                this.events.onConnectionError(new Error(`Error accepting unidirectional streams: ${error}`));
            }
        }
    }

    /**
     * Accepts bidirectional streams from the server
     */
    private async acceptBidirectionalStreams(): Promise<void> {
        try {
            const reader = this.wt.incomingBidirectionalStreams.getReader();

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }

                // Process the stream
                this.readFromStream(value.readable);
            }
        } catch (error) {
            if (this.events.onConnectionError) {
                this.events.onConnectionError(new Error(`Error accepting bidirectional streams: ${error}`));
            }
        }
    }

    /**
     * Reads data from a stream
     * @param stream The stream to read from
     */
    private async readFromStream(stream: ReadableStream<Uint8Array>): Promise<void> {
        try {
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }

                chunks.push(value);
            }

            // Combine all chunks
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const combinedData = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                combinedData.set(chunk, offset);
                offset += chunk.length;
            }

            // Process the combined data
            this.processProtobufData(combinedData);
        } catch (error) {
            if (this.events.onConnectionError) {
                this.events.onConnectionError(new Error(`Error reading from stream: ${error}`));
            }
        }
    }

    /**
     * Processes protobuf data
     * @param data The protobuf data
     */
    private processProtobufData(data: Uint8Array): void {
        if (data.length < 1) {
            return;
        }

        // First byte is the packet type
        const packetType = data[0];
        const messageData = data.slice(1);

        switch (packetType) {
            case PacketType.AUTH_RESPONSE_SUCCESS:
                this.handleAuthResponseSuccess(messageData);
                break;
            case PacketType.AUTH_RESPONSE_ERROR:
                this.handleAuthResponseError(messageData);
                break;
            case PacketType.JOIN_ROOM_RESPONSE:
                this.handleJoinRoomResponse(messageData);
                break;
            case PacketType.USER_JOINED:
                this.handleUserJoined(messageData);
                break;
            case PacketType.USER_LEFT:
                this.handleUserLeft(messageData);
                break;
            default:
                console.warn(`Unknown packet type: ${packetType}`);
        }
    }

    /**
     * Handles an authentication success response
     * @param data The response data
     */
    private handleAuthResponseSuccess(data: Uint8Array): void {
        try {
            const response = fromBinary(AuthResponseSuccessSchema, data);
            this.sessionId = response.sessionId;

            if (this.events.onAuthSuccess) {
                this.events.onAuthSuccess(response.sessionId);
            }
        } catch (error) {
            console.error("Error parsing auth success response:", error);
        }
    }

    /**
     * Handles an authentication error response
     * @param data The response data
     */
    private handleAuthResponseError(data: Uint8Array): void {
        try {
            const response = fromBinary(AuthResponseErrorSchema, data);

            if (this.events.onAuthError) {
                this.events.onAuthError(response.type);
            }
        } catch (error) {
            console.error("Error parsing auth error response:", error);
        }
    }

    /**
     * Handles a join room response
     * @param data The response data
     */
    private handleJoinRoomResponse(data: Uint8Array): void {
        try {
            const response = fromBinary(JoinRoomResponseSchema, data);

            if (this.events.onJoinedRoom) {
                this.events.onJoinedRoom(response.users);
            }
        } catch (error) {
            console.error("Error parsing join room response:", error);
        }
    }

    /**
     * Handles a user joined event
     * @param data The event data
     */
    private handleUserJoined(data: Uint8Array): void {
        try {
            const user = fromBinary(RoomUserSchema, data);

            if (this.events.onUserJoined) {
                this.events.onUserJoined(user);
            }
        } catch (error) {
            console.error("Error parsing user joined event:", error);
        }
    }

    /**
     * Handles a user left event
     * @param data The event data
     */
    private handleUserLeft(data: Uint8Array): void {
        try {
            // User left data is just the session ID (8 bytes)
            if (data.length >= 8) {
                const sessionId = this.bytesToBigInt(data);

                if (this.events.onUserLeft) {
                    this.events.onUserLeft(sessionId);
                }
            }
        } catch (error) {
            console.error("Error parsing user left event:", error);
        }
    }

    /**
     * Sends a protobuf message
     * @param packetType The packet type
     * @param message The message to send
     */
    private async sendProtobufMessage<T extends keyof PacketTypeToMessage>(packetType: T, message: PacketTypeToMessage[T]): Promise<void> {
        if (!this.datagramWriter) {
            throw new Error("Datagram writer not available");
        }

        let messageBytes: Uint8Array;
        switch (packetType) {
            case PacketType.AUTH_REQUEST:
                messageBytes = toBinary(AuthRequestSchema, message as AuthRequest);
                break;
            case PacketType.JOIN_ROOM_REQUEST:
                messageBytes = toBinary(JoinRoomRequestSchema, message as JoinRoomRequest);
                break;
            default:
                throw new Error("Invalid packet type");
        }

        // Create a packet with the packet type as the first byte
        const packet = new Uint8Array(messageBytes.length + 1);
        packet[0] = packetType;
        packet.set(messageBytes, 1);

        // Send the packet
        await this.datagramWriter.write(packet);
    }

    /**
     * Converts bytes to a BigInt
     * @param bytes The bytes to convert
     */
    private bytesToBigInt(bytes: Uint8Array): bigint {
        let result = 0n;
        for (let i = 0; i < bytes.length; i++) {
            result = (result << 8n) | BigInt(bytes[i]);
        }
        return result;
    }
}

// Default export
export default VoiceChatClient;
