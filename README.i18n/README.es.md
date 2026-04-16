# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)


**La capa de mensajería para agentes.**

IM.codes es un mensajero especializado para agentes de programación con IA. Te permite seguir sesiones largas desde iPhone, iPad, Apple Watch, móvil o web, con acceso a terminal, navegación de archivos, vistas de Git, vista previa de localhost, notificaciones y flujos multiagente integrados. Funciona con [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenClaw](https://openclaw.com) y [Qwen](https://github.com/QwenLM/qwen-agent).

> **Nota:** Este archivo es una traducción. **El README en inglés (`../README.md`) es la versión canónica.** Si hay alguna diferencia, prevalece la versión en inglés.

Claude Code y Codex ahora admiten dos modos de integración: CLI y SDK.

## Capturas

### Escritorio

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="../landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="../landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="../landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="../landing/imcodes2.png" width="24%" /></a>
</p>

### iPad / Tableta

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="../landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="../landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### Móvil

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="../landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="../landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="../landing/imcodes-m8.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="../landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="../landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="../landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="../landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="../landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="../landing/imcodes-m0.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="../landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="../landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="../landing/imcodes-watch2.png" width="31%" /></a>
</p>


La compatibilidad con Apple Watch cubre monitorización rápida de sesiones, contadores de no leídos, notificaciones push y respuestas rápidas desde la muñeca.

## Descarga

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

Compatible con iPhone, iPad y Apple Watch. También disponible como [web app](https://app.im.codes) y mediante `npm install -g imcodes` (CLI del daemon).

## Por qué

Cuando te alejas del escritorio, la mayoría de los flujos con coding agents se rompen. El agente sigue ejecutándose en un terminal, pero continuar normalmente implica SSH, `tmux attach`, escritorios remotos o esperar hasta volver al portátil.

[IM.codes](https://im.codes) mantiene esas sesiones al alcance desde móvil o web: abrir el terminal, inspeccionar archivos y cambios Git, previsualizar localhost desde otro dispositivo, recibir notificaciones cuando el trabajo termina y mantener varios agentes en marcha sobre tu propia infraestructura.

No es otro IDE de IA ni un cliente genérico de terminal remota. Es la capa de mensajería y control alrededor de coding agents basados en terminal.

Este es un proyecto personal. Yo prácticamente no escribí código: fue construido casi por completo por [Claude Code](https://github.com/anthropics/claude-code), con contribuciones importantes de [Codex](https://github.com/openai/codex) y [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## Shared Agent Context y memoria

Esto ya es una función central del producto, no un detalle interno de implementación. IM.codes convierte continuamente el trabajo ya resuelto de los agentes en memoria reutilizable y vuelve a inyectar ese contexto en sesiones futuras.

- **Se guarda problema → solución, no ruido de logs.** Solo se materializan las salidas finales `assistant.text`; se excluyen deltas en streaming, tool calls, tool results y ruido intermedio.
- **Memoria personal con sincronización opcional en la nube.** La memoria cruda y la procesada permanecen siempre en local; los resúmenes procesados pueden sincronizarse opcionalmente con un pool en la nube a nivel de usuario compartido entre tus dispositivos.
- **Enterprise Shared Context consultable.** Los equipos pueden publicar memoria reutilizable en ámbitos workspace/project, inspeccionarla desde la UI, consultarla y ver estadísticas, en lugar de esconder contexto dentro de prompts invisibles.
- **Recuperación multilingüe.** La búsqueda semántica local y el recall del servidor con pgvector usan embeddings multilingües para encontrar soluciones relacionadas entre inglés, chino, japonés, coreano, español, ruso y repos mixtos.
- **Inyección automática donde importa.** El historial relevante se inyecta tanto por mensaje como al iniciar la sesión, con tarjetas en la timeline que muestran qué se recuperó, por qué, la puntuación de relevancia, el número de recalls y el último uso.
- **Visible y controlable por el usuario.** La UI de Shared Context separa raw events, processed summaries, cloud memory y enterprise memory, con controles de consulta, vista previa, archive/restore y configuración de procesamiento.

## Funciones

### Terminal remota
Acceso completo al terminal de tus sesiones de agente desde cualquier navegador, sin SSH, VPN ni port forwarding. Puedes alternar entre modo terminal bruto y una vista de chat estructurada con tool calls, bloques de thinking y salida en streaming.

### Navegador de archivos y cambios Git
Explora archivos del proyecto en árbol, sube y descarga archivos, revisa estado Git con conteo de líneas añadidas y eliminadas, y abre vistas previas flotantes con resaltado de sintaxis y diff.

### Vista previa web local
Previsualiza tu servidor de desarrollo local desde cualquier dispositivo sin desplegar nada. El daemon hace proxy del tráfico `localhost` a través de un túnel WebSocket seguro.

### Móvil, reloj y notificaciones
Soporte completo para móvil, autenticación biométrica, notificaciones push, entrada interactiva para sesiones shell y respuestas rápidas desde Apple Watch.

### Auditoría cross-modelo y discusiones P2P
La salida de un solo modelo no debería confiarse ciegamente. Las discusiones P2P permiten que múltiples agentes — de distintos proveedores y estilos de pensamiento — colaboren en el análisis del mismo código antes de escribir una sola línea. Cada ronda sigue un pipeline multifase personalizable, donde cada agente lee todas las contribuciones anteriores. Diferentes modelos detectan diferentes tipos de problemas. Esta revisión cruzada entre proveedores encuentra la mayoría de los problemas antes de la implementación, reduciendo drásticamente el retrabajo.

Modos integrados: `audit` (pipeline estructurado audit → review → plan), `review`, `discuss` y `brainstorm` — o define tu propia secuencia de fases. Funciona con Claude Code, Codex, Gemini CLI y Qwen.

### Agentes transport con streaming
Soporte nativo de streaming para agentes transport como OpenClaw y Qwen, sin scraping de terminal.

### Comunicación agente a agente
Los agentes pueden enviarse mensajes directamente mediante `imcodes send`.

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

También puedes usar sesiones `script` para automatizar flujos personalizados.

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:
{line}"
                ])
    time.sleep(30)
```

```bash
# Webhook → agent: GitHub webhook handler triggers code review
curl -X POST https://your-server/webhook -d '{"pr": 42}' \
  && imcodes send "Gemini" "review PR #42, write summary to /tmp/review.md"

# CI → agent: post-build trigger
imcodes send "Claude" "tests failed on main, check CI log at /tmp/ci.log and fix" --reply
```

### Selector `@` inteligente
`@` busca archivos del proyecto; `@@` selecciona agentes para despacho P2P.

### Gestión de múltiples servidores y sesiones
Conecta varias máquinas de desarrollo a un único panel.

### Barra lateral estilo Discord
Barra de iconos de servidor, árbol jerárquico de sesiones, contadores de no leídos y paneles fijados.

### Paneles fijables
Cualquier ventana flotante se puede fijar a la barra lateral.

### Panel del repositorio
Consulta issues, PRs, ramas, commits y ejecuciones CI/CD desde la app.

### Tareas programadas (Cron)
Automatiza flujos de agentes recurrentes con programación estilo cron.

### Sincronización entre dispositivos
Orden de pestañas y paneles fijados se sincronizan a través de la API de preferencias del servidor.

### Internacionalización
La interfaz soporta 7 idiomas.

### Actualizaciones OTA
El daemon puede actualizarse vía npm y dispararse desde la web.

## Lo que IM.codes no es

- No es otro IDE de IA
- No es solo un wrapper de chat
- No es solo un cliente de terminal remota
- No reemplaza Claude Code, Codex, Gemini CLI, OpenClaw o Qwen
- Es la capa de mensajería y control alrededor de ellos

## Arquitectura

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

El daemon se ejecuta en tu máquina y gestiona sesiones a través de tmux o protocolos transport. El servidor reenvía las conexiones entre tus dispositivos y el daemon. Todo permanece en tu propia infraestructura.

## Instalación

```bash
npm install -g imcodes
```

## Inicio rápido

> **Se recomienda encarecidamente autoalojar.** La instancia compartida `app.im.codes` es solo para pruebas.

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

Este comando vincula tu máquina, inicia el daemon, lo registra como servicio del sistema y hace que la máquina aparezca en el panel web/móvil.

### Conexión OpenClaw

Si OpenClaw está ejecutándose localmente, conecta IM.codes al gateway de OpenClaw en la máquina donde corre el daemon:

```bash
imcodes connect openclaw
```

Esto:

- se conecta por defecto a `ws://127.0.0.1:18789`
- reutiliza automáticamente el token desde `~/.openclaw/openclaw.json`
- sincroniza sesiones principales e hijas de OpenClaw en IM.codes
- guarda la configuración en `~/.imcodes/openclaw.json`
- reinicia el daemon para permitir la reconexión automática

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

Notas:

- las URLs remotas `ws://` sin TLS requieren `--insecure`
- usa `imcodes disconnect openclaw` para eliminar la configuración guardada
- este flujo solo se ha probado en macOS

## Autoalojado

### Configuración en un solo comando

```bash
npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

### Configuración manual

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

El `docker-compose.yml` generado ya usa `pgvector/pgvector:pg16` para PostgreSQL.

## Windows (experimental)

Windows está soportado de forma nativa mediante ConPTY.

```cmd
npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

```cmd
imcodes upgrade
```

```cmd
imcodes repair-watchdog
```

```cmd
npm prefix -g
```

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

```
%USERPROFILE%\.imcodes\watchdog.log
```

## Requisitos

- macOS o Linux
- Windows (experimental) vía ConPTY
- Node.js >= 22
- tmux en Linux/macOS
- Al menos un coding agent: Claude Code, Codex, Gemini CLI, OpenClaw o Qwen

## Descargo de responsabilidad

IM.codes es un proyecto independiente de código abierto y no está afiliado, respaldado ni patrocinado por Anthropic, OpenAI, Google, Alibaba, OpenClaw ni ninguna otra empresa mencionada.

## Licencia

[MIT](../LICENSE)

© 2026 [IM.codes](https://im.codes)
