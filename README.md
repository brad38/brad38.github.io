# Espelha — protótipo WebRTC

Protótipo estático de compartilhamento de tela P2P pelo navegador, pensado para ser publicado no GitHub Pages.

## O que já funciona

- Captura de tela/janela/aba com `getDisplayMedia()`.
- Opções 1080p/720p/automático e 30/60/120 FPS.
- Bitrate configurável de automático até 50 Mbps por espectador.
- H.264 priorizado para favorecer aceleração de hardware; o navegador pode usar NVENC quando disponível.
- Áudio da tela quando o navegador/SO oferece suporte.
- Microfone opcional.
- Sala aleatória com link compartilhável.
- Espectadores entram via `?room=CODIGO`.
- WebRTC P2P usando PeerJS para sinalização.
- Contador de espectadores no host.
- Tela cheia e controle de áudio no espectador.
- Layout responsivo.

## Testar localmente

Não abra somente o `index.html` por `file://`. Rode em `localhost`:

```bash
python -m http.server 8080
```

Depois abra:

```text
http://localhost:8080
```

Para testar com duas máquinas, publique no GitHub Pages ou use um servidor HTTPS acessível pelas duas.

## Publicar no GitHub Pages

1. Crie um repositório, por exemplo `espelha`.
2. Envie `index.html`, `styles.css`, `app.js` e `.nojekyll` para a raiz.
3. No GitHub: **Settings → Pages**.
4. Em **Build and deployment**, selecione **Deploy from a branch**.
5. Escolha a branch `main` e a pasta `/ (root)`.

A URL ficará parecida com:

```text
https://SEU-USUARIO.github.io/espelha/
```

## Arquitetura deste protótipo

```text
Host browser ── WebRTC media ──> Viewer browser
      │                              │
      └──── PeerJS Cloud signaling ──┘
```

O PeerJS Cloud só faz a sinalização inicial. A mídia tenta trafegar P2P entre os navegadores.

## Limitações importantes

- Este é um protótipo. O PeerJS Cloud público não deve ser tratado como infraestrutura de produção.
- Sem servidor TURN próprio, alguns pares atrás de NAT/firewalls restritivos podem não conseguir estabelecer a conexão.
- Em P2P simples, o host envia um stream por espectador. Com muitos espectadores, o upload cresce rapidamente.
- Para grupos maiores, a evolução natural é usar um SFU, como LiveKit, mediasoup ou Janus.
- A captura de áudio do sistema varia entre navegador e sistema operacional. O Chrome/Edge costuma oferecer áudio de aba com mais consistência.

## Dependência externa

PeerJS 1.5.5 via jsDelivr.
