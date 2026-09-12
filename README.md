# Espelha

Compartilhamento de tela direto pelo navegador, com baixa latência e sem necessidade de conta ou instalação obrigatória.

O **Espelha** é uma aplicação web de compartilhamento de tela baseada em WebRTC. A proposta é permitir que uma pessoa compartilhe sua tela, janela ou aba do navegador e envie um link para outras pessoas assistirem em tempo real.

O projeto foi pensado para situações em que você só quer mostrar sua tela para alguém sem precisar criar servidor, entrar em chamada ou instalar um aplicativo específico.

---

## Sobre o projeto

O funcionamento é baseado em salas temporárias.

Quem transmite cria uma sala e recebe um código e um link compartilhável. Quem recebe esse link pode entrar diretamente pelo navegador e assistir à transmissão.

A mídia é transmitida utilizando **WebRTC**, buscando estabelecer uma conexão direta entre os navegadores.

O **PeerJS** é utilizado para facilitar o processo de sinalização necessário para estabelecer essas conexões.

---

## Recursos

* Compartilhamento de tela, janela ou aba
* Transmissão em 720p ou 1080p
* Suporte a 30 e 60 FPS
* Ajuste automático de resolução
* Áudio da tela quando suportado pelo navegador
* Microfone opcional
* Salas com código aleatório
* Links compartilháveis
* Entrada sem cadastro
* Contador de espectadores
* Controle de áudio para quem assiste
* Modo tela cheia
* Interface responsiva
* Suporte a instalação como PWA
* Interface adaptada para desktop e dispositivos móveis

---

## Interface

O Espelha foi desenvolvido com foco em uma experiência simples: abrir, compartilhar e enviar o link.

Não há sistema de contas, perfis ou configuração complexa antes de iniciar uma transmissão.

O fluxo básico é:

Criar transmissão → escolher a tela → receber o código da sala → compartilhar o link → assistir pelo navegador.

---

## Tecnologias

O projeto utiliza uma stack propositalmente simples.

### Frontend

* HTML
* CSS
* JavaScript

### Comunicação

* WebRTC
* PeerJS

### Recursos do navegador

* MediaDevices API
* `getDisplayMedia()`
* `getUserMedia()`
* Fullscreen API
* Clipboard API
* Service Workers
* Web App Manifest

### Hospedagem

* GitHub Pages

---

## Arquitetura

O PeerJS participa da descoberta e da negociação entre os navegadores. Depois que a conexão é estabelecida, a transmissão utiliza WebRTC.

A arquitetura atual prioriza conexões P2P, fazendo com que a mídia tente trafegar diretamente entre quem transmite e quem assiste.

---

## PWA

O Espelha também pode ser instalado como uma aplicação web progressiva.

Quando instalado, ele pode ser aberto em uma janela própria, mantendo a mesma aplicação web e os mesmos recursos da versão acessada pelo navegador.

A instalação não é obrigatória para transmitir ou assistir.

---

## Privacidade

O Espelha não possui sistema próprio de contas e não foi projetado para armazenar gravações das transmissões.

A captura da tela é iniciada somente após autorização explícita do usuário através do seletor fornecido pelo próprio navegador.

O projeto também possui uma página dedicada de **Política de Privacidade** com informações sobre os serviços externos utilizados pelo site.

---

## Limitações atuais

O projeto ainda utiliza uma arquitetura P2P simples.

Isso significa que cada espectador representa uma nova transmissão enviada pelo computador de quem está compartilhando. Por isso, o modelo atual é mais adequado para transmissões entre pequenos grupos.

Redes com NAT ou firewall mais restritivos também podem impedir uma conexão direta quando não é possível estabelecer uma rota WebRTC adequada.

Outra limitação importante é a captura de tela em dispositivos móveis, já que navegadores móveis atualmente possuem restrições para compartilhar a tela completa do sistema.

---

## Possíveis evoluções

* Servidor TURN próprio
* Melhoria na estabilidade das conexões
* Informações de qualidade da transmissão em tempo real
* Seleção dinâmica de bitrate
* Reconexão automática
* Proteção opcional de salas
* Melhorias para redes lentas
* Arquitetura SFU para grupos maiores

---

## Status

O Espelha está em desenvolvimento ativo.

A versão atual já permite criar salas, compartilhar a tela e assistir à transmissão diretamente pelo navegador.
