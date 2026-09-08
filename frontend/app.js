document.addEventListener('DOMContentLoaded', () => {
    const statusBadge = document.getElementById('status-badge');
    const connectBtn = document.getElementById('connect-btn');
    const disconnectBtn = document.getElementById('disconnect-btn');
    const micBtn = document.getElementById('mic-btn');
    const avatarImage = document.getElementById('avatar-image');
    const avatarCanvas = document.getElementById('avatar-canvas');
    const avatarPlaceholder = document.getElementById('avatar-placeholder');
    const avatarVideo = document.getElementById('avatar-video');
    const chatLog = document.getElementById('chat-log');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

    let socket = null;
    let audioContext = null;
    let audioStack = [];
    let nextAudioTime = 0;
    
    let mediaSource = null;
    let sourceBuffer = null;
    let videoQueue = [];

    // Microphone variables
    let micStream = null;
    let micAudioContext = null;
    let micProcessor = null;
    let isRecording = false;

    function processVideoQueue() {
        if (!sourceBuffer || sourceBuffer.updating || videoQueue.length === 0 || mediaSource?.readyState !== 'open') {
            return;
        }
        try {
            sourceBuffer.appendBuffer(videoQueue.shift());
        } catch (e) {
            console.error("AppendBuffer failed:", e);
        }
    }

    // 1. Initialize Media Source
    function initMediaSource() {
        if (!window.MediaSource) {
            console.error("MediaSource is not supported in this browser.");
            return;
        }
        
        videoQueue = [];
        mediaSource = new MediaSource();
        avatarVideo.src = URL.createObjectURL(mediaSource);

        mediaSource.addEventListener('sourceopen', () => {
            console.log("MediaSource opened. Probing for codecs...");
            const codecs = [
                'video/mp4; codecs="avc1.42c020, mp4a.40.2"',
                'video/mp4; codecs="avc1.42E01E"',
                'video/mp4; codecs="avc1.4d001f"',
                'video/mp4; codecs="avc1.64001f"',
                'video/mp4; codecs="vp09.00.10.08"',
                'video/webm; codecs="vp9"',
                'video/mp4'
            ];

            let supportedCodec = null;
            for (const codec of codecs) {
                if (MediaSource.isTypeSupported(codec)) {
                    supportedCodec = codec;
                    break;
                }
            }

            if (supportedCodec) {
                console.log(`MediaSource using codec: ${supportedCodec}`);
                try {
                    sourceBuffer = mediaSource.addSourceBuffer(supportedCodec);
                    sourceBuffer.addEventListener('updateend', () => {
                        processVideoQueue();
                        if (avatarVideo.paused && avatarVideo.readyState >= 3) {
                            avatarVideo.play().catch(e => {
                                avatarVideo.muted = true;
                                avatarVideo.play().catch(err => {});
                            });
                        }
                    });
                    processVideoQueue();
                } catch (err) {
                    console.error("Failed to add SourceBuffer:", err);
                }
            } else {
                console.error("No supported codecs found.");
            }
        });
    }

    // 2. Base64 Decoder
    function base64ToArrayBuffer(base64) {
        const cleanBase64 = base64.replace(/\s/g, '');
        const binaryString = window.atob(cleanBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // 3. Audio Handlers
    function initAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            nextAudioTime = audioContext.currentTime;
        }
    }

    function pcm16ToFloat32(uint8Array) {
        const int16Array = new Int16Array(uint8Array.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }
        return float32Array;
    }

    function queueAudioFrame(mimeType, base64Data) {
        initAudioContext();
        if (!audioContext) return;

        const arrayBuffer = base64ToArrayBuffer(base64Data);
        const sampleRate = 24000;
        const floatData = pcm16ToFloat32(new Uint8Array(arrayBuffer));

        const audioBuffer = audioContext.createBuffer(1, floatData.length, sampleRate);
        audioBuffer.getChannelData(0).set(floatData);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        if (nextAudioTime < audioContext.currentTime) {
            nextAudioTime = audioContext.currentTime;
        }
        source.start(nextAudioTime);
        nextAudioTime += audioBuffer.duration;

        audioStack.push(source);
    }

    function stopAudio() {
        audioStack.forEach(source => {
            try { source.stop(); } catch (e) {}
        });
        audioStack = [];
        if (audioContext) {
            nextAudioTime = audioContext.currentTime;
        }
    }

    let lastSpeaker = null;
    let lastMessageEl = null;

    function appendMessage(author, text, type, isStreaming = true) {
        if (isStreaming && lastSpeaker === type && lastMessageEl) {
            // Append with space
            lastMessageEl.textContent += " " + text;
            // Clean up multiple spaces
            lastMessageEl.textContent = lastMessageEl.textContent.replace(/\s+/g, ' ');
            chatLog.scrollTop = chatLog.scrollHeight;
        } else {
            const messageEl = document.createElement('div');
            messageEl.className = `message ${type}`;
            messageEl.textContent = text;
            chatLog.appendChild(messageEl);
            chatLog.scrollTop = chatLog.scrollHeight;
            lastSpeaker = type;
            lastMessageEl = messageEl;
        }
    }

    function sendMessage() {
        const text = userInput.value.trim();
        if (!text) return;

        appendMessage("You", text, 'user', false);
        userInput.value = '';

        const clientMessage = {
            realtimeInput: {
                text: text
            }
        };

        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(clientMessage));
        } else {
            appendMessage("System", "Not connected to backend.", 'system');
        }
    }

    // Microphone Recording Logic
    async function toggleMicrophone() {
        if (isRecording) {
            stopMicrophone();
        } else {
            startMicrophone();
        }
    }

    async function startMicrophone() {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
            micAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = micAudioContext.createMediaStreamSource(micStream);
            
            // Using ScriptProcessorNode to capture raw PCM audio to send directly to Gemini Live
            micProcessor = micAudioContext.createScriptProcessor(4096, 1, 1);
            
            micProcessor.onaudioprocess = (e) => {
                if (!socket || socket.readyState !== WebSocket.OPEN) return;
                
                const float32Array = e.inputBuffer.getChannelData(0);
                const int16Array = new Int16Array(float32Array.length);
                
                for (let i = 0; i < float32Array.length; i++) {
                    const s = Math.max(-1, Math.min(1, float32Array[i]));
                    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                
                const uint8Array = new Uint8Array(int16Array.buffer);
                let binaryString = "";
                for (let i = 0; i < uint8Array.length; i += 4096) {
                    const chunk = uint8Array.subarray(i, i + 4096);
                    binaryString += String.fromCharCode.apply(null, chunk);
                }
                const base64Data = btoa(binaryString);
                
                const message = {
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm;rate=16000",
                            data: base64Data
                        }]
                    }
                };
                socket.send(JSON.stringify(message));
            };
            
            source.connect(micProcessor);
            micProcessor.connect(micAudioContext.destination);
            
            isRecording = true;
            micBtn.classList.add("active");
        } catch (err) {
            console.error("Error accessing microphone:", err);
            appendMessage("System", "Could not access microphone.", "system");
        }
    }

    function stopMicrophone() {
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
            micStream = null;
        }
        if (micProcessor) {
            micProcessor.disconnect();
            micProcessor = null;
        }
        if (micAudioContext) {
            micAudioContext.close();
            micAudioContext = null;
        }
        isRecording = false;
        micBtn.classList.remove("active");
    }

    // 4. Message Handler
    function handleServerMessage(message) {
        if (message.error) {
            appendMessage("System", `Error: ${message.error}`, 'system', false);
            return;
        }

        const serverContent = message.serverContent || message.server_content;
        if (!serverContent) return;

        const inputTranscription = serverContent.inputTranscription || serverContent.input_transcription;
        if (inputTranscription && inputTranscription.text) {
            appendMessage("You (Spoken)", inputTranscription.text, 'user', true);
        }

        const outputTranscription = serverContent.outputTranscription || serverContent.output_transcription;
        if (outputTranscription && outputTranscription.text) {
            appendMessage("Live Avatar (Transcript)", outputTranscription.text, 'model', true);
        }

        if (serverContent.interrupted) {
            console.log("Model interrupted.");
            stopAudio();
            return;
        }

        const modelTurn = serverContent.modelTurn || serverContent.model_turn;
        if (!modelTurn || !modelTurn.parts) return;

        for (const part of modelTurn.parts) {
            if (part.text) {
                appendMessage("Live Avatar", part.text, 'model', true);
            } else {
                const inlineData = part.inlineData || part.inline_data || part.video;
                if (inlineData) {
                    const mimeType = inlineData.mimeType || inlineData.mime_type;
                    const data = inlineData.data;

                    if (mimeType && mimeType.startsWith('image/')) {
                        avatarImage.src = `data:${mimeType};base64,${data}`;
                    } else if (mimeType && mimeType.startsWith('video/')) {
                        const arrayBuffer = base64ToArrayBuffer(data);
                        videoQueue.push(arrayBuffer);
                        processVideoQueue();
                    } else if (mimeType && mimeType.startsWith('audio/')) {
                        queueAudioFrame(mimeType, data);
                    } else if (!mimeType) {
                        queueAudioFrame('audio/pcm', data);
                    }
                }
            }
        }
    }

    // 5. Connect and initialize WebSocket
    function connect() {
        if (socket && socket.readyState !== WebSocket.CLOSED) return;

        statusBadge.textContent = "Connecting...";
        statusBadge.className = "badge";

        const wsUrl = `ws://${window.location.hostname}:8080`;
        console.log(`Connecting to ${wsUrl}...`);
        
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            console.log("WebSocket connected to backend.");
            statusBadge.textContent = "Connected";
            statusBadge.className = "badge connected";
            
            connectBtn.style.display = 'none';
            disconnectBtn.style.display = 'block';
            
            userInput.disabled = false;
            sendBtn.disabled = false;
            micBtn.disabled = false;
            
            initMediaSource();
            
            if (avatarPlaceholder) avatarPlaceholder.style.display = 'none';
            if (avatarVideo) {
                avatarVideo.style.display = 'block';
            }
            
            document.body.addEventListener('click', () => {
                initAudioContext();
                if (avatarVideo) avatarVideo.muted = false;
            }, { once: true });
        };

        socket.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const message = JSON.parse(event.data);
                    handleServerMessage(message);
                } catch (err) {
                    console.error("Error parsing JSON message:", err);
                }
            }
        };

        socket.onclose = () => {
            console.log("WebSocket disconnected.");
            handleDisconnectState();
        };

        socket.onerror = (error) => {
            console.error("WebSocket error:", error);
            handleDisconnectState();
        };
    }

    function disconnect() {
        if (socket) {
            socket.close();
        }
        stopMicrophone();
        handleDisconnectState();
    }

    function handleDisconnectState() {
        statusBadge.textContent = "Disconnected";
        statusBadge.className = "badge disconnected";
        
        connectBtn.style.display = 'block';
        disconnectBtn.style.display = 'none';
        
        userInput.disabled = true;
        sendBtn.disabled = true;
        micBtn.disabled = true;
        
        if (avatarPlaceholder) avatarPlaceholder.style.display = 'flex';
        if (avatarVideo) avatarVideo.style.display = 'none';
        
        stopAudio();
    }

    // 6. Bind Events
    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    
    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);
    
    micBtn.addEventListener('click', toggleMicrophone);
});
