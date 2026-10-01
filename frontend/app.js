document.addEventListener('DOMContentLoaded', () => {
    const statusBadge = document.getElementById('status-badge');
    const connectBtn = document.getElementById('connect-btn');
    const disconnectBtn = document.getElementById('disconnect-btn');
    const micBtn = document.getElementById('mic-btn');
    const cameraBtn = document.getElementById('camera-btn');
    const screenBtn = document.getElementById('screen-btn');
    const inputPreview = document.getElementById('input-preview');
    const tutorName = document.getElementById('tutor-name');
    const avatarSelect = document.getElementById('avatar-select');
    const voiceSelect = document.getElementById('voice-select');

    const avatarImage = document.getElementById('avatar-image');
    const avatarCanvas = document.getElementById('avatar-canvas');
    const avatarPlaceholder = document.getElementById('avatar-placeholder');
    const avatarStatus = document.getElementById('avatar-status');

    function showPlaceholder(connecting) {
        avatarPlaceholder.style.display = 'flex';
        avatarPlaceholder.querySelector('.spinner').style.display = connecting ? 'block' : 'none';
        avatarPlaceholder.querySelector('.placeholder-icon').style.display = connecting ? 'none' : 'block';
        avatarStatus.textContent = connecting ? 'Connecting to your avatar...' : 'Click Connect to start';
    }
    const avatarVideo = document.getElementById('avatar-video');
    const chatLog = document.getElementById('chat-log');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

    // Artifacts UI elements
    const appContainer = document.querySelector('.app-container');
    const artifactsToggleBtn = document.getElementById('artifacts-toggle-btn');
    const artifactsBadgeCount = document.getElementById('artifacts-badge-count');
    const artifactsPane = document.getElementById('artifacts-pane');
    const artifactsPaneCount = document.getElementById('artifacts-pane-count');
    const artifactsCloseBtn = document.getElementById('artifacts-close-btn');
    const artifactsExpandBtn = document.getElementById('artifacts-expand-btn');
    const artifactsEmpty = document.getElementById('artifacts-empty');
    const artifactsContent = document.getElementById('artifacts-content');
    const featuredMediaWrapper = document.getElementById('featured-media-wrapper');
    const featuredTypePill = document.getElementById('featured-type-pill');
    const featuredModelPill = document.getElementById('featured-model-pill');
    const featuredTime = document.getElementById('featured-time');
    const featuredPrompt = document.getElementById('featured-prompt');
    const featuredDownloadBtn = document.getElementById('featured-download-btn');
    const featuredFullscreenBtn = document.getElementById('featured-fullscreen-btn');
    const featuredCopyBtn = document.getElementById('featured-copy-btn');
    const featuredCopyText = document.getElementById('featured-copy-text');
    const artifactsGalleryStrip = document.getElementById('artifacts-gallery-strip');

    // Lightbox modal elements
    const mediaLightbox = document.getElementById('media-lightbox');
    const lightboxBackdrop = document.getElementById('lightbox-backdrop');
    const lightboxCloseBtn = document.getElementById('lightbox-close-btn');
    const lightboxContent = document.getElementById('lightbox-content');
    const lightboxCaption = document.getElementById('lightbox-caption');

    // Size the avatar box to the stream so the frame is never cropped
    function fitAvatarContainer() {
        if (!avatarVideo.videoWidth || !avatarVideo.videoHeight) return;
        const container = avatarVideo.parentElement;
        container.style.aspectRatio = `${avatarVideo.videoWidth} / ${avatarVideo.videoHeight}`;
        console.log(`Avatar stream ${avatarVideo.videoWidth}x${avatarVideo.videoHeight}`);
    }
    avatarVideo.addEventListener('loadedmetadata', fitAvatarContainer);
    avatarVideo.addEventListener('resize', fitAvatarContainer);
    avatarVideo.addEventListener('canplay', () => {
        if (avatarVideo.paused && sourceBuffer && !sourceBuffer.updating && avatarVideo.readyState >= 3) {
            avatarVideo.play().catch(() => {});
        }
    });
    avatarVideo.addEventListener('seeked', () => {
        if (avatarVideo.paused && avatarVideo.readyState >= 3) {
            avatarVideo.play().catch(() => {});
        }
    });


    let socket = null;

    // High-Fidelity Audio Streaming & Lip-Sync Alignment
    const AUDIO_SAMPLE_RATE = 24000;
    // Delay audio playback by ~200ms when starting a turn:
    // 1) Buffers 3-4 chunks to eliminate buffer underruns & crackle from network jitter
    // 2) Matches the ~200ms decode/render latency of HTML5 Video/MediaSource to align lip-sync
    const AUDIO_PREBUFFER_SEC = 0.20;
    let audioContext = null;
    let masterGain = null;
    let audioStack = [];
    let nextAudioTime = 0;
    let audioPrebuffer = [];
    let isPlayingAudio = false;
    let prebufferTimeout = null;
    let leftoverAudioBytes = null;
    
    let mediaSource = null;
    let sourceBuffer = null;
    let videoQueue = [];

    let micStream = null;
    let micAudioContext = null;
    let micProcessor = null;
    let isRecording = false;

    // Avatars and voices come from the backend (/config), which also holds the defaults
    let reconnectAfterClose = false;

    function addOption(select, value, label) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    }

    async function populateTeacherPicker() {
        let config = { avatars: { 'Professional': ['Kira'] }, voices: { 'Aoede': 'Breezy' }, defaults: { avatar: 'Kira', voice: 'Aoede' } };
        try {
            const response = await fetch('/config');
            if (response.ok) config = await response.json();
        } catch (e) {
            console.warn('Could not load /config, using defaults:', e);
        }
        avatarSelect.innerHTML = '';
        voiceSelect.innerHTML = '';
        for (const [style, names] of Object.entries(config.avatars)) {
            const group = document.createElement('optgroup');
            group.label = style;
            for (const name of names) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                group.appendChild(option);
            }
            avatarSelect.appendChild(group);
        }
        for (const [name, description] of Object.entries(config.voices)) {
            addOption(voiceSelect, name, `${name} (${description.toLowerCase()})`);
        }
        let avatar = config.defaults.avatar;
        let voice = config.defaults.voice;
        try {
            avatar = localStorage.getItem('avatar') || avatar;
            voice = localStorage.getItem('voice') || voice;
        } catch (e) {}
        avatarSelect.value = avatar;
        voiceSelect.value = voice;
        if (!avatarSelect.value) avatarSelect.value = config.defaults.avatar;
        if (!voiceSelect.value) voiceSelect.value = config.defaults.voice;
        updateTutorName();
    }

    function updateTutorName() {
        tutorName.textContent = `Professor ${avatarSelect.value}`;
        const subtitle = document.querySelector('.header-titles p');
        if (subtitle) subtitle.textContent = `Your tutor: Professor ${avatarSelect.value}`;
    }

    function onTeacherChange() {
        updateTutorName();
        try {
            localStorage.setItem('avatar', avatarSelect.value);
            localStorage.setItem('voice', voiceSelect.value);
        } catch (e) {}
        if (socket && socket.readyState === WebSocket.OPEN) {
            appendMessage("System", `Switching to Professor ${avatarSelect.value}...`, "system", false);
            reconnectAfterClose = true;
            disconnect();
        }
    }

    // Camera or screen input, sent to the model as JPEG frames at 1 fps
    let videoStream = null;
    let videoSource = null;
    let frameTimer = null;
    const frameCanvas = document.createElement('canvas');
    const FRAME_INTERVAL_MS = 1000;
    const FRAME_MAX_SIDE = 768;

    // Generated media cards, keyed by tool call id
    const mediaCards = new Map();

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
                        skipVideoGap();
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

    function base64ToArrayBuffer(base64) {
        const cleanBase64 = base64.replace(/\s/g, '');
        const binaryString = window.atob(cleanBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function initAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            masterGain = audioContext.createGain();
            masterGain.gain.setValueAtTime(1, audioContext.currentTime);
            masterGain.connect(audioContext.destination);
            nextAudioTime = audioContext.currentTime;
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }
    }

    function pcm16ToFloat32(uint8Array) {
        let combined = uint8Array;
        if (leftoverAudioBytes && leftoverAudioBytes.length > 0) {
            const merged = new Uint8Array(leftoverAudioBytes.length + uint8Array.length);
            merged.set(leftoverAudioBytes, 0);
            merged.set(uint8Array, leftoverAudioBytes.length);
            combined = merged;
            leftoverAudioBytes = null;
        }

        const sampleCount = Math.floor(combined.length / 2);
        if (combined.length % 2 !== 0) {
            leftoverAudioBytes = combined.slice(sampleCount * 2);
        }

        const int16Array = new Int16Array(combined.buffer, combined.byteOffset, sampleCount);
        const float32Array = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }
        return float32Array;
    }

    function scheduleAudioChunk(floatData, isFirstChunkOfTurn = false) {
        if (!audioContext || !masterGain || floatData.length === 0) return;

        const audioBuffer = audioContext.createBuffer(1, floatData.length, AUDIO_SAMPLE_RATE);
        audioBuffer.getChannelData(0).set(floatData);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;

        // Apply a 4ms micro-fade on the first chunk of a turn to prevent DC offset clicks
        const chunkGain = audioContext.createGain();
        if (isFirstChunkOfTurn) {
            chunkGain.gain.setValueAtTime(0, nextAudioTime);
            chunkGain.gain.linearRampToValueAtTime(1, nextAudioTime + 0.004);
        } else {
            chunkGain.gain.setValueAtTime(1, nextAudioTime);
        }

        source.connect(chunkGain);
        chunkGain.connect(masterGain);

        source.start(nextAudioTime);
        nextAudioTime += audioBuffer.duration;

        audioStack.push(source);
        source.onended = () => {
            const idx = audioStack.indexOf(source);
            if (idx !== -1) audioStack.splice(idx, 1);
            if (audioStack.length === 0 && audioPrebuffer.length === 0) {
                isPlayingAudio = false;
            }
        };
    }

    function flushPrebuffer() {
        if (prebufferTimeout) {
            clearTimeout(prebufferTimeout);
            prebufferTimeout = null;
        }
        if (audioPrebuffer.length === 0) return;

        isPlayingAudio = true;
        // Schedule starting right now with a 10ms head room for the audio thread quantum
        nextAudioTime = audioContext.currentTime + 0.01;

        let first = true;
        while (audioPrebuffer.length > 0) {
            const chunk = audioPrebuffer.shift();
            scheduleAudioChunk(chunk, first);
            first = false;
        }
    }

    function queueAudioFrame(mimeType, base64Data) {
        initAudioContext();
        if (!audioContext) return;

        const arrayBuffer = base64ToArrayBuffer(base64Data);
        const floatData = pcm16ToFloat32(new Uint8Array(arrayBuffer));
        if (floatData.length === 0) return;

        // If audio is actively playing
        if (isPlayingAudio) {
            // Jitter underrun recovery: if schedule fell behind currentTime, reset smoothly with margin
            if (nextAudioTime < audioContext.currentTime) {
                nextAudioTime = audioContext.currentTime + 0.04;
                scheduleAudioChunk(floatData, true);
            } else {
                scheduleAudioChunk(floatData, false);
            }
            return;
        }

        // Starting a new turn: accumulate in pre-buffer first
        audioPrebuffer.push(floatData);
        const bufferedSamples = audioPrebuffer.reduce((sum, c) => sum + c.length, 0);
        const bufferedSec = bufferedSamples / AUDIO_SAMPLE_RATE;

        if (bufferedSec >= AUDIO_PREBUFFER_SEC) {
            flushPrebuffer();
        } else if (!prebufferTimeout) {
            prebufferTimeout = setTimeout(() => {
                flushPrebuffer();
            }, 180);
        }
    }

    function stopAudio() {
        if (prebufferTimeout) {
            clearTimeout(prebufferTimeout);
            prebufferTimeout = null;
        }
        audioPrebuffer = [];
        isPlayingAudio = false;
        leftoverAudioBytes = null;

        if (masterGain && audioContext) {
            try {
                // Smooth 10ms fade out to avoid abrupt cutoff clicks on interruption
                masterGain.gain.setValueAtTime(masterGain.gain.value, audioContext.currentTime);
                masterGain.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.01);
            } catch (e) {}
        }

        setTimeout(() => {
            audioStack.forEach(source => {
                try { source.stop(); } catch (e) {}
            });
            audioStack = [];
            if (masterGain && audioContext) {
                masterGain.gain.setValueAtTime(1, audioContext.currentTime);
            }
            if (audioContext) {
                nextAudioTime = audioContext.currentTime;
            }
        }, 12);
    }

    // Drop the avatar video that is buffered but not yet played, so an interruption cuts it short
    function flushAvatarVideo() {
        videoQueue = [];
        if (!sourceBuffer || mediaSource?.readyState !== 'open') return;
        try {
            if (sourceBuffer.updating) sourceBuffer.abort();
            const buffered = sourceBuffer.buffered;
            if (buffered.length) {
                const from = avatarVideo.currentTime + 0.1;
                const end = buffered.end(buffered.length - 1);
                if (end > from) sourceBuffer.remove(from, end);
            }
        } catch (e) {
            console.warn("Could not flush avatar video:", e);
        }
    }

    // After a flush the next response starts later on the timeline; jump over the gap
    function skipVideoGap() {
        const buffered = avatarVideo.buffered;
        if (!buffered.length) return;
        const lastStart = buffered.start(buffered.length - 1);
        if (avatarVideo.currentTime < lastStart - 0.05) {
            avatarVideo.currentTime = lastStart;
        }
    }

    let lastSpeaker = null;
    let lastMessageEl = null;

    function appendMessage(author, text, type, isStreaming = true) {
        if (isStreaming && lastSpeaker === type && lastMessageEl) {
            lastMessageEl.textContent += " " + text;
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

    function mediaLabel(kind, state) {
        const model = kind === 'video' ? 'Gemini Omni' : 'Nano Banana';
        const noun = kind === 'video' ? 'video' : 'image';
        if (state === 'pending') return `Generating ${noun} with ${model}`;
        if (state === 'failed') return `${noun.charAt(0).toUpperCase() + noun.slice(1)} generation failed`;
        return `${noun.charAt(0).toUpperCase() + noun.slice(1)} generated with ${model}`;
    }

    // Artifacts Pane State & Management: 'expanded' | 'minimized'
    const artifactsMap = new Map(); // id -> artifact
    let activeArtifactId = null;
    let artifactsPaneMode = 'expanded'; // 'expanded' | 'minimized'

    function formatArtifactTime(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function registerArtifact(id, kind, prompt) {
        let artifact = artifactsMap.get(id);
        if (!artifact) {
            artifact = {
                id,
                kind,
                prompt: prompt || '',
                state: 'pending',
                timestamp: new Date(),
                model: kind === 'video' ? 'Gemini Omni' : 'Nano Banana',
                url: null,
                mimeType: null,
                data: null,
                error: null
            };
            artifactsMap.set(id, artifact);
        } else {
            artifact.kind = kind;
            if (prompt) artifact.prompt = prompt;
        }
        activeArtifactId = id;
        if (artifactsPaneMode === 'expanded') {
            expandArtifactsPane();
        } else {
            minimizeArtifactsPane();
        }
        return artifact;
    }

    function completeArtifact(media) {
        const kind = media.kind === 'video' ? 'video' : 'image';
        const mimeType = media.mimeType || media.mime_type || (kind === 'video' ? 'video/mp4' : 'image/png');
        const blob = new Blob([base64ToArrayBuffer(media.data)], { type: mimeType });
        const url = URL.createObjectURL(blob);

        let artifact = artifactsMap.get(media.id);
        if (!artifact) {
            artifact = {
                id: media.id,
                kind,
                prompt: media.prompt || '',
                timestamp: new Date(),
                model: kind === 'video' ? 'Gemini Omni' : 'Nano Banana'
            };
            artifactsMap.set(media.id, artifact);
        }
        artifact.state = 'done';
        artifact.url = url;
        artifact.mimeType = mimeType;
        artifact.data = media.data;
        if (media.prompt) artifact.prompt = media.prompt;

        if (!activeArtifactId || activeArtifactId === media.id) {
            activeArtifactId = media.id;
        }

        if (artifactsPaneMode === 'expanded') {
            expandArtifactsPane();
        } else {
            minimizeArtifactsPane();
        }
        return { artifact, url, mimeType };
    }

    function failArtifact(error) {
        const kind = error.kind === 'video' ? 'video' : 'image';
        let artifact = artifactsMap.get(error.id);
        if (!artifact) {
            artifact = {
                id: error.id,
                kind,
                prompt: '',
                timestamp: new Date(),
                model: kind === 'video' ? 'Gemini Omni' : 'Nano Banana'
            };
            artifactsMap.set(error.id, artifact);
        }
        artifact.state = 'failed';
        artifact.error = error.message || 'Generation failed.';
        renderArtifactsPane();
        return artifact;
    }

    function expandArtifactsPane() {
        if (!artifactsPane) return;
        artifactsPaneMode = 'expanded';
        artifactsPane.style.display = 'flex';
        artifactsPane.classList.remove('minimized');
        if (appContainer) {
            appContainer.classList.add('has-artifacts-pane');
            appContainer.classList.remove('artifacts-minimized');
        }
        if (artifactsToggleBtn) {
            artifactsToggleBtn.classList.add('active');
            artifactsToggleBtn.title = 'Minimize Artifacts Pane';
        }
        if (artifactsExpandBtn) artifactsExpandBtn.style.display = 'none';
        if (artifactsCloseBtn) artifactsCloseBtn.style.display = 'flex';
        renderArtifactsPane();
    }

    function minimizeArtifactsPane() {
        if (!artifactsPane) return;
        if (artifactsMap.size === 0) {
            hideArtifactsPane();
            return;
        }
        artifactsPaneMode = 'minimized';
        artifactsPane.style.display = 'flex';
        artifactsPane.classList.add('minimized');
        if (appContainer) {
            appContainer.classList.add('has-artifacts-pane', 'artifacts-minimized');
        }
        if (artifactsToggleBtn) {
            artifactsToggleBtn.classList.remove('active');
            artifactsToggleBtn.title = 'Expand Artifacts Pane';
        }
        if (artifactsExpandBtn) artifactsExpandBtn.style.display = 'flex';
        if (artifactsCloseBtn) artifactsCloseBtn.style.display = 'none';
        renderArtifactsPane();
    }

    function hideArtifactsPane() {
        if (!artifactsPane) return;
        artifactsPaneMode = 'minimized';
        artifactsPane.style.display = 'none';
        if (appContainer) appContainer.classList.remove('has-artifacts-pane', 'artifacts-minimized');
        if (artifactsToggleBtn) artifactsToggleBtn.classList.remove('active');
    }

    function toggleArtifactsPane() {
        if (artifactsPaneMode === 'expanded') {
            minimizeArtifactsPane();
        } else {
            expandArtifactsPane();
        }
    }

    function selectArtifact(id) {
        if (!artifactsMap.has(id)) return;
        activeArtifactId = id;
        expandArtifactsPane();
        renderArtifactsPane();
    }

    function renderArtifactsPane() {
        const count = artifactsMap.size;
        if (artifactsBadgeCount) artifactsBadgeCount.textContent = count;
        if (artifactsPaneCount) {
            artifactsPaneCount.textContent = artifactsPaneMode === 'minimized' ? `${count}` : `${count} ${count === 1 ? 'item' : 'items'}`;
        }
        
        if (count > 0 && artifactsToggleBtn) {
            artifactsToggleBtn.style.display = 'inline-flex';
        }

        if (count === 0) {
            hideArtifactsPane();
            return;
        }

        if (artifactsEmpty) artifactsEmpty.style.display = 'none';
        if (artifactsContent) artifactsContent.style.display = 'flex';

        // Featured stage (only populated when expanded)
        const active = artifactsMap.get(activeArtifactId) || Array.from(artifactsMap.values())[artifactsMap.size - 1];
        if (!active) return;
        activeArtifactId = active.id;

        if (artifactsPaneMode === 'expanded' && featuredMediaWrapper) {
            featuredMediaWrapper.innerHTML = '';
            if (active.state === 'pending') {
                const pendingBox = document.createElement('div');
                pendingBox.className = 'featured-pending';
                pendingBox.innerHTML = `
                    <div class="spinner"></div>
                    <div class="featured-pending-text">Generating ${active.kind} with ${active.model}...</div>
                    <div class="featured-pending-prompt">${active.prompt ? `"${active.prompt}"` : ''}</div>
                `;
                featuredMediaWrapper.appendChild(pendingBox);

                if (featuredTypePill) {
                    featuredTypePill.innerHTML = `<span class="material-icons" style="font-size: 14px;">hourglass_top</span> Pending`;
                }
                if (featuredModelPill) featuredModelPill.textContent = active.model;
                if (featuredTime) featuredTime.textContent = formatArtifactTime(active.timestamp);
                if (featuredPrompt) {
                    featuredPrompt.textContent = active.prompt;
                    featuredPrompt.style.display = active.prompt ? 'block' : 'none';
                }

                if (featuredDownloadBtn) featuredDownloadBtn.style.display = 'none';
                if (featuredFullscreenBtn) featuredFullscreenBtn.style.display = 'none';
                if (featuredCopyBtn) featuredCopyBtn.style.display = active.prompt ? 'inline-flex' : 'none';
            } else if (active.state === 'failed') {
                const failedBox = document.createElement('div');
                failedBox.className = 'featured-failed';
                failedBox.innerHTML = `
                    <span class="material-icons">error_outline</span>
                    <div style="font-weight: 600;">Generation Failed</div>
                    <div class="featured-failed-msg">${active.error || 'An error occurred during generation.'}</div>
                `;
                featuredMediaWrapper.appendChild(failedBox);

                if (featuredTypePill) {
                    featuredTypePill.innerHTML = `<span class="material-icons" style="font-size: 14px;">warning</span> Failed`;
                }
                if (featuredModelPill) featuredModelPill.textContent = active.model;
                if (featuredTime) featuredTime.textContent = formatArtifactTime(active.timestamp);
                if (featuredPrompt) {
                    featuredPrompt.textContent = active.prompt;
                    featuredPrompt.style.display = active.prompt ? 'block' : 'none';
                }

                if (featuredDownloadBtn) featuredDownloadBtn.style.display = 'none';
                if (featuredFullscreenBtn) featuredFullscreenBtn.style.display = 'none';
                if (featuredCopyBtn) featuredCopyBtn.style.display = active.prompt ? 'inline-flex' : 'none';
            } else {
                // Done
                let mediaEl;
                if (active.kind === 'video') {
                    mediaEl = document.createElement('video');
                    mediaEl.src = active.url;
                    mediaEl.controls = true;
                    mediaEl.autoplay = true;
                    mediaEl.loop = true;
                    mediaEl.muted = true;
                    mediaEl.playsInline = true;
                } else {
                    mediaEl = document.createElement('img');
                    mediaEl.src = active.url;
                    mediaEl.alt = active.prompt || 'Generated image';
                    mediaEl.title = 'Click to view full size';
                    mediaEl.addEventListener('click', () => openLightbox(active));
                }
                featuredMediaWrapper.appendChild(mediaEl);

                if (featuredTypePill) {
                    featuredTypePill.innerHTML = `<span class="material-icons" style="font-size: 14px;">${active.kind === 'video' ? 'movie' : 'image'}</span> ${active.kind === 'video' ? 'Video' : 'Image'}`;
                }
                if (featuredModelPill) featuredModelPill.textContent = active.model;
                if (featuredTime) featuredTime.textContent = formatArtifactTime(active.timestamp);
                if (featuredPrompt) {
                    featuredPrompt.textContent = active.prompt;
                    featuredPrompt.style.display = active.prompt ? 'block' : 'none';
                }

                if (featuredDownloadBtn) {
                    featuredDownloadBtn.style.display = 'inline-flex';
                    featuredDownloadBtn.href = active.url;
                    const ext = (active.mimeType && active.mimeType.split('/')[1]) || (active.kind === 'video' ? 'mp4' : 'png');
                    featuredDownloadBtn.download = `${active.kind}-${active.id}.${ext}`;
                }

                if (featuredFullscreenBtn) {
                    featuredFullscreenBtn.style.display = 'inline-flex';
                    featuredFullscreenBtn.onclick = () => openLightbox(active);
                }

                if (featuredCopyBtn) featuredCopyBtn.style.display = active.prompt ? 'inline-flex' : 'none';
            }
        }

        // Render gallery strip
        if (artifactsGalleryStrip) {
            artifactsGalleryStrip.innerHTML = '';
            const list = Array.from(artifactsMap.values()).reverse(); // newest first
            for (const item of list) {
                const thumb = document.createElement('div');
                thumb.className = `artifact-thumb ${item.id === activeArtifactId ? 'active' : ''} ${item.state === 'pending' ? 'pending-thumb' : ''} ${item.state === 'failed' ? 'failed-thumb' : ''}`;
                thumb.title = item.prompt || `${item.kind} artifact`;

                if (item.state === 'pending') {
                    const sp = document.createElement('div');
                    sp.className = 'spinner small';
                    thumb.appendChild(sp);
                } else if (item.state === 'failed') {
                    const icon = document.createElement('span');
                    icon.className = 'material-icons';
                    icon.textContent = 'broken_image';
                    thumb.appendChild(icon);
                } else if (item.kind === 'video') {
                    const videoThumb = document.createElement('video');
                    videoThumb.src = item.url;
                    videoThumb.muted = true;
                    videoThumb.preload = 'metadata';
                    thumb.appendChild(videoThumb);
                } else {
                    const imgThumb = document.createElement('img');
                    imgThumb.src = item.url;
                    imgThumb.alt = item.prompt || 'Thumbnail';
                    thumb.appendChild(imgThumb);
                }

                const badge = document.createElement('div');
                badge.className = 'artifact-thumb-badge';
                const badgeIcon = document.createElement('span');
                badgeIcon.className = 'material-icons';
                badgeIcon.textContent = item.kind === 'video' ? 'movie' : 'image';
                badge.appendChild(badgeIcon);
                thumb.appendChild(badge);

                thumb.addEventListener('click', () => selectArtifact(item.id));
                artifactsGalleryStrip.appendChild(thumb);
            }
        }
    }

    function openLightbox(artifact) {
        if (!artifact || artifact.state !== 'done' || !mediaLightbox) return;
        if (lightboxContent) lightboxContent.innerHTML = '';
        let mediaEl;
        if (artifact.kind === 'video') {
            mediaEl = document.createElement('video');
            mediaEl.src = artifact.url;
            mediaEl.controls = true;
            mediaEl.autoplay = true;
            mediaEl.loop = true;
            mediaEl.playsInline = true;
        } else {
            mediaEl = document.createElement('img');
            mediaEl.src = artifact.url;
            mediaEl.alt = artifact.prompt || 'Full size artifact';
        }
        if (lightboxContent) lightboxContent.appendChild(mediaEl);
        if (lightboxCaption) {
            lightboxCaption.textContent = artifact.prompt ? `"${artifact.prompt}"` : `${artifact.kind} (${artifact.model})`;
        }
        mediaLightbox.style.display = 'flex';
    }

    function closeLightbox() {
        if (!mediaLightbox) return;
        const vid = lightboxContent ? lightboxContent.querySelector('video') : null;
        if (vid) vid.pause();
        mediaLightbox.style.display = 'none';
        if (lightboxContent) lightboxContent.innerHTML = '';
    }

    function createMediaCard(id, kind, prompt) {
        // Register artifact in the separate pane store
        registerArtifact(id, kind, prompt);

        const card = document.createElement('div');
        card.className = `message media-card pending ${kind}`;
        card.dataset.id = id;

        const header = document.createElement('div');
        header.className = 'media-header';
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.textContent = kind === 'video' ? 'movie' : 'image';
        const label = document.createElement('span');
        label.className = 'media-label';
        label.textContent = mediaLabel(kind, 'pending');
        header.append(icon, label);

        const promptEl = document.createElement('p');
        promptEl.className = 'media-prompt';
        promptEl.textContent = prompt;

        const body = document.createElement('div');
        body.className = 'media-body';
        const spinner = document.createElement('div');
        spinner.className = 'spinner small';
        body.appendChild(spinner);

        card.append(header, promptEl, body);

        // Clicking the media card focuses it in the artifacts pane
        card.addEventListener('click', (e) => {
            if (e.target.closest('a') || e.target.closest('button')) return;
            selectArtifact(id);
        });

        chatLog.appendChild(card);
        chatLog.scrollTop = chatLog.scrollHeight;

        // The next transcript chunk starts a new bubble below the card
        lastSpeaker = null;
        lastMessageEl = null;

        mediaCards.set(id, card);
        return card;
    }

    function showGeneratedMedia(media) {
        const { artifact, url, mimeType } = completeArtifact(media);
        const kind = artifact.kind;
        const card = mediaCards.get(media.id) || createMediaCard(media.id, kind, media.prompt || '');

        const body = card.querySelector('.media-body');
        body.innerHTML = '';
        let element;
        if (kind === 'video') {
            element = document.createElement('video');
            element.src = url;
            element.controls = true;
            element.autoplay = true;
            element.loop = true;
            element.muted = true;
            element.playsInline = true;
        } else {
            element = document.createElement('img');
            element.src = url;
            element.alt = media.prompt || 'Generated image';
            element.addEventListener('click', (e) => {
                e.stopPropagation();
                selectArtifact(media.id);
            });
        }
        body.appendChild(element);

        const footer = document.createElement('div');
        footer.className = 'media-footer';

        const viewInPaneBtn = document.createElement('button');
        viewInPaneBtn.type = 'button';
        viewInPaneBtn.className = 'view-in-pane-btn';
        viewInPaneBtn.innerHTML = '<span class="material-icons">visibility</span> View in Pane';
        viewInPaneBtn.onclick = (e) => {
            e.stopPropagation();
            selectArtifact(media.id);
        };
        footer.appendChild(viewInPaneBtn);

        const link = document.createElement('a');
        link.href = url;
        link.download = `${kind}-${media.id}.${mimeType.split('/')[1] || 'bin'}`;
        const linkIcon = document.createElement('span');
        linkIcon.className = 'material-icons';
        linkIcon.textContent = 'download';
        link.append(linkIcon, document.createTextNode('Download'));
        footer.appendChild(link);
        card.appendChild(footer);

        card.classList.remove('pending');
        card.querySelector('.media-label').textContent = mediaLabel(kind, 'done');
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    function showGenerationError(error) {
        failArtifact(error);
        const kind = error.kind === 'video' ? 'video' : 'image';
        const card = mediaCards.get(error.id) || createMediaCard(error.id, kind, '');
        const body = card.querySelector('.media-body');
        body.innerHTML = '';
        body.textContent = error.message || 'Generation failed.';
        card.classList.remove('pending');
        card.classList.add('failed');
        card.querySelector('.media-label').textContent = mediaLabel(kind, 'failed');
        chatLog.scrollTop = chatLog.scrollHeight;
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
            
            // Using ScriptProcessorNode to capture raw PCM audio (1024 samples @ 16kHz = 64ms chunks, within 20-100ms optimal window)
            micProcessor = micAudioContext.createScriptProcessor(1024, 1, 1);
            
            let sentChunks = 0;
            micProcessor.onaudioprocess = (e) => {
                if (!socket || socket.readyState !== WebSocket.OPEN) return;
                sentChunks += 1;
                if (sentChunks === 1 || sentChunks % 100 === 0) console.log(`Sent ${sentChunks} audio chunks`);
                
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
                        audio: {
                            mimeType: "audio/pcm;rate=16000",
                            data: base64Data
                        }
                    }
                };
                socket.send(JSON.stringify(message));
            };
            
            source.connect(micProcessor);
            micProcessor.connect(micAudioContext.destination);
            
            isRecording = true;
            micBtn.classList.add("active");
            const trackSettings = micStream.getAudioTracks()[0]?.getSettings() || {};
            console.log(`Microphone on: context ${micAudioContext.sampleRate} Hz, track ${trackSettings.sampleRate || '?'} Hz, state ${micAudioContext.state}`);
            appendMessage("System", "Microphone on. Speak, then pause so the avatar can answer.", "system", false);
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
        if (isRecording) appendMessage("System", "Microphone off.", "system", false);
        isRecording = false;
        micBtn.classList.remove("active");
    }

    async function toggleVideoInput(source) {
        if (videoSource === source) {
            stopVideoInput();
            return;
        }
        stopVideoInput();
        try {
            videoStream = source === 'screen'
                ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
                : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        } catch (err) {
            console.error(`Could not start ${source}:`, err);
            appendMessage("System", source === 'screen' ? "Could not share the screen." : "Could not access the camera.", "system", false);
            return;
        }
        videoSource = source;
        inputPreview.srcObject = videoStream;
        inputPreview.style.display = 'block';
        (source === 'screen' ? screenBtn : cameraBtn).classList.add('sharing');
        videoStream.getVideoTracks()[0].addEventListener('ended', stopVideoInput);
        frameTimer = setInterval(sendVideoFrame, FRAME_INTERVAL_MS);
        appendMessage("System", source === 'screen' ? "Screen sharing on. The avatar can see your screen." : "Camera on. The avatar can see your camera.", "system", false);
    }

    function sendVideoFrame() {
        if (!socket || socket.readyState !== WebSocket.OPEN || !inputPreview.videoWidth) return;
        const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(inputPreview.videoWidth, inputPreview.videoHeight));
        frameCanvas.width = Math.round(inputPreview.videoWidth * scale);
        frameCanvas.height = Math.round(inputPreview.videoHeight * scale);
        frameCanvas.getContext('2d').drawImage(inputPreview, 0, 0, frameCanvas.width, frameCanvas.height);
        const base64Data = frameCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        socket.send(JSON.stringify({
            realtimeInput: {
                video: {
                    mimeType: "image/jpeg",
                    data: base64Data
                }
            }
        }));
    }

    function stopVideoInput() {
        if (frameTimer) {
            clearInterval(frameTimer);
            frameTimer = null;
        }
        if (videoStream) {
            videoStream.getTracks().forEach(track => track.stop());
            videoStream = null;
        }
        inputPreview.srcObject = null;
        inputPreview.style.display = 'none';
        cameraBtn.classList.remove('sharing');
        screenBtn.classList.remove('sharing');
        if (videoSource) appendMessage("System", videoSource === 'screen' ? "Screen sharing off." : "Camera off.", "system", false);
        videoSource = null;
    }

    function handleServerMessage(message) {
        if (message.error) {
            appendMessage("System", `Error: ${message.error}`, 'system', false);
            return;
        }

        // Tool calls from the model: show a pending card while the backend generates the media
        const toolCall = message.toolCall || message.tool_call;
        if (toolCall) {
            const calls = toolCall.functionCalls || toolCall.function_calls || [];
            for (const call of calls) {
                const args = call.args || {};
                if (call.name === 'generate_image') createMediaCard(call.id, 'image', args.prompt || '');
                else if (call.name === 'generate_video') createMediaCard(call.id, 'video', args.prompt || '');
                else if (call.name === 'edit_image') createMediaCard(call.id, 'image', `Edit: ${args.instruction || ''}`);
                else if (call.name === 'edit_video') createMediaCard(call.id, 'video', `Edit: ${args.instruction || ''}`);
            }
            return;
        }

        // Results pushed by the backend once a generation finished
        if (message.generatedMedia) {
            showGeneratedMedia(message.generatedMedia);
            return;
        }
        if (message.generationError) {
            showGenerationError(message.generationError);
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
            flushAvatarVideo();
            lastSpeaker = null;
            lastMessageEl = null;
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

    function connect() {
        if (socket && socket.readyState !== WebSocket.CLOSED) return;

        statusBadge.textContent = "Connecting...";
        statusBadge.className = "badge";
        showPlaceholder(true);

        const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        const query = `?avatar=${encodeURIComponent(avatarSelect.value)}&voice=${encodeURIComponent(voiceSelect.value)}`;
        const wsUrl = wsProtocol + (window.location.host || 'localhost:8080') + '/' + query;
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
            cameraBtn.disabled = false;
            screenBtn.disabled = false;
            
            initMediaSource();
            
            if (avatarPlaceholder) avatarPlaceholder.style.display = 'none';
            if (avatarVideo) {
                avatarVideo.style.display = 'block';
            }
            
            document.body.addEventListener('click', () => {
                initAudioContext();
                if (avatarVideo) avatarVideo.muted = true;
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
            if (reconnectAfterClose) {
                reconnectAfterClose = false;
                connect();
            }
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
        stopVideoInput();
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
        cameraBtn.disabled = true;
        screenBtn.disabled = true;
        stopVideoInput();
        
        showPlaceholder(false);
        if (avatarVideo) avatarVideo.style.display = 'none';
        
        stopAudio();
    }

    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    
    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);
    
    micBtn.addEventListener('click', toggleMicrophone);
    avatarSelect.addEventListener('change', onTeacherChange);
    voiceSelect.addEventListener('change', onTeacherChange);
    populateTeacherPicker();
    cameraBtn.addEventListener('click', () => toggleVideoInput('camera'));
    screenBtn.addEventListener('click', () => toggleVideoInput('screen'));

    // Artifacts Pane & Lightbox Event Listeners
    if (artifactsToggleBtn) artifactsToggleBtn.addEventListener('click', toggleArtifactsPane);
    if (artifactsCloseBtn) artifactsCloseBtn.addEventListener('click', minimizeArtifactsPane);
    if (artifactsExpandBtn) artifactsExpandBtn.addEventListener('click', expandArtifactsPane);
    if (lightboxCloseBtn) lightboxCloseBtn.addEventListener('click', closeLightbox);
    if (lightboxBackdrop) lightboxBackdrop.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && mediaLightbox && mediaLightbox.style.display !== 'none') {
            closeLightbox();
        }
    });
    if (featuredCopyBtn) {
        featuredCopyBtn.addEventListener('click', () => {
            const active = artifactsMap.get(activeArtifactId);
            if (active && active.prompt) {
                navigator.clipboard.writeText(active.prompt).then(() => {
                    if (featuredCopyText) featuredCopyText.textContent = 'Copied!';
                    setTimeout(() => {
                        if (featuredCopyText) featuredCopyText.textContent = 'Copy';
                    }, 1500);
                }).catch(() => {});
            }
        });
    }
});