#!/usr/bin/env node
import { ArgumentParser } from 'argparse';
import { createReadStream, existsSync, promises as fs } from 'fs';
import httpProxy from 'http-proxy';
import jsBeautify from 'js-beautify';
import JSZip from 'jszip';
import Koa from 'koa';
import views from 'koa-views';
import koaConditionalGet from 'koa-conditional-get';
import fetch from 'node-fetch';
import path from 'path';
import { getGamePath } from 'steam-game-path';
import { Transform } from 'stream';
import { fileURLToPath, URL } from 'url';
import os from 'os';
import chalk from 'chalk';

// Log welcome message
console.log('🧩', chalk.yellowBright('Screepers Steamless Client'));

// Parse program arguments
const argv = (function () {
    const parser = new ArgumentParser();
    parser.add_argument('--beautify', {
        action: 'store_true',
        default: false,
    });
    parser.add_argument('--package', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--port', {
        nargs: '?',
        type: 'int',
    });
    parser.add_argument('--backend', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--host', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--internal_backend', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--server_list', {
        nargs: '?',
        type: 'str',
    });
    return parser.parse_args();
})();

// Error logging
const error = (...args: unknown[]) => console.error('❌', chalk.bold.red('Error'), ...args);

// Extract arguments
const beautify = argv.beautify;

// Create proxy
const proxy = httpProxy.createProxyServer({ changeOrigin: true });
proxy.on('error', (err) => error(err));

// Use Steam to locate Screeps package
const getPathFromSteam = () => {
    const steam = getGamePath(464350);
    if (steam?.game) {
        return path.join(steam.game.path, 'package.nw');
    }
};

// Backup method to locate Screeps package
const getPathFromSystem = () => {
    const screepsPath = ['steamapps', 'common', 'Screeps', 'package.nw'];
    const windowsPath = ['Program Files (x86)', 'Steam', ...screepsPath];
    switch (process.platform) {
        case 'darwin': // macOS
            return path.join(os.homedir(), 'Library', 'Application Support', 'Steam', ...screepsPath);
        case 'linux':
            if (process.env.WSL_DISTRO_NAME) {
                return path.join('/mnt/c/', ...windowsPath);
            }
            return path.join(os.homedir(), '.steam', 'steam', ...screepsPath);
        case 'win32':
            return path.join('C:', ...windowsPath);
    }
};

const exitOnPackageError = () => {
    error('Could not find the Screeps "package.nw".');
    error('Use the "--package" argument to specify the path to the "package.nw" file.');
    process.exit(1);
};

// Locate and read `package.nw`
const [data, stat] = await (async function () {
    const pkgPath = argv.package ?? getPathFromSteam() ?? getPathFromSystem();
    if (!pkgPath || !existsSync(pkgPath)) exitOnPackageError();
    return Promise.all([fs.readFile(pkgPath), fs.stat(pkgPath)]).catch(exitOnPackageError);
})();

// Read package zip metadata
const zip = new JSZip();
await zip.loadAsync(data);

// HTTP header is only accurate to the minute
const lastModified = stat.mtime;

// Set up koa server
const koa = new Koa();
const port = argv.port ?? 8080;
const host = argv.host ?? 'localhost';
const server = koa.listen(port, host);
server.on('error', (err) => error(err));

// Extract backend and endpoint from URL
const extract = (url: string) => {
    if (argv.backend) {
        return {
            backend: argv.backend.replace(/\/+$/, ''),
            endpoint: url,
        };
    }
    const groups = /^\/\((?<backend>[^)]+)\)(?<endpoint>\/.*)$/.exec(url)?.groups;
    if (groups) {
        return {
            backend: groups.backend.replace(/\/+$/, ''),
            endpoint: groups.endpoint,
        };
    }
};

// Script content to inject into the client index.html
const generateScriptContent = (backend: string) => {
    if (localStorage.backendDomain && localStorage.backendDomain !== backend) {
        const keysToPreserve = ['game.room.displayOptions', 'game.world-map.displayOptions2', 'game.editor.hidden'];
        for (const key of Object.keys(localStorage)) {
            if (!keysToPreserve.includes(key)) {
                localStorage.removeItem(key);
            }
        }
    }
    localStorage.backendDomain = backend;
    if (
        (localStorage.auth === 'null' && localStorage.prevAuth === 'null') ||
        60 * 60 * 1000 < Date.now() - localStorage.lastToken ||
        (localStorage.prevAuth !== '"guest"' && (localStorage.auth === 'null' || !localStorage.auth))
    ) {
        localStorage.auth = '"guest"';
    }
    localStorage.tutorialVisited = 'true';
    localStorage.placeSpawnTutorialAsked = '1';
    localStorage.tipTipOfTheDay = '-1';
    localStorage.prevAuth = localStorage.auth;
    localStorage.lastToken = Date.now();
    (function () {
        let auth = localStorage.auth;
        setInterval(() => {
            if (auth !== localStorage.auth) {
                auth = localStorage.auth;
                localStorage.lastToken = Date.now();
            }
        }, 1000);
    })();
    // The client will just fill this up with data until the application breaks.
    if (localStorage['users.code.activeWorld']?.length > 1024 * 1024) {
        try {
            type UserCode = { timestamp: number };
            const code = JSON.parse(localStorage['users.code.activeWorld']);
            localStorage['users.code.activeWorld'] = JSON.stringify(
                code.sort((a: UserCode, b: UserCode) => b.timestamp - a.timestamp).slice(0, 2),
            );
        } catch (err) {
            delete localStorage['users.code.activeWorld'];
        }
    }
    // Send the user to map after login from /register
    addEventListener('message', () => {
        setTimeout(() => {
            if (localStorage.auth && localStorage.auth !== '"guest"' && document.location.hash === '#!/register') {
                document.location.hash = '#!/';
            }
        });
    });
};

// Converts the script content into a string that can be injected into the client index.html
const generateScript = (backend: string) => {
    const scriptContent = generateScriptContent.toString();
    const firstBraceIndex = scriptContent.indexOf('{');
    const extractedContent = scriptContent.substring(firstBraceIndex + 1, scriptContent.length - 1);

    return `<script>
        const backend = '${JSON.stringify(backend)}';
        ${extractedContent}
    </script>`;
};

// Get system path for public files dir
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const indexFile = 'index.ejs';

interface Server {
    type: string;
    name: string;
    url: string;
    api: string;
    subdomain?: string;
}

const getServerListConfig = async () => {
    let serverListPath = argv.server_list;
    if (!serverListPath) {
        const serverListFile = 'server_list.json';
        serverListPath = path.join(__dirname, `../settings/${serverListFile}`);
        if (!existsSync(serverListPath)) {
            serverListPath = path.join(__dirname, serverListFile);
        }
    }

    const serverConfig: Server[] = JSON.parse(await fs.readFile(serverListPath, 'utf-8'));
    const serverTypes = Array.from(new Set(serverConfig.map((server) => server.type)));
    const serverList = serverTypes.map((type) => {
        const serversOfType = serverConfig
            .filter((server) => server.type === type)
            .map((server) => {
                const subdomain = host === 'localhost' && server.subdomain ? `${server.subdomain}.` : '';
                let { origin, pathname } = new URL(server.url);
                pathname = pathname.endsWith('/') ? pathname : `${pathname}/`;

                const url = `http://${subdomain}${host}:${port}/(${origin})${pathname}`;
                const api = `http://${host}:${port}/(${origin})${pathname}api/version`;
                return { ...server, url, api };
            });

        return {
            name: type.charAt(0).toUpperCase() + type.slice(1),
            logo: type === 'official' ? serversOfType[0].url + 'logotype.svg' : undefined,
            servers: serversOfType,
        };
    });

    return serverList;
};

// Setup views for rendering ejs files
koa.use(views(path.join(__dirname, '../views'), { extension: 'ejs' }));

// Serve client assets directly from steam package
koa.use(koaConditionalGet());

// Render the index.ejs file and pass the serverList variable
koa.use(async (context, next) => {
    if (argv.backend) return next(); // Skip if backend is specified

    if (['/', 'index.html'].includes(context.path)) {
        const serverList = await getServerListConfig();
        if (serverList.length) {
            await context.render(indexFile, { serverList });
            return;
        }
    }

    return next();
});

// Public files to serve
const publicFiles = [
    { file: 'public/favicon.png', type: 'image/png' },
    { file: 'public/style.css', type: 'text/css' },
    { file: 'dist/serverStatus.js', type: 'text/javascript' },
];

// Serve public files
koa.use(async (context, next) => {
    if (argv.backend) return next(); // Skip if backend is specified

    const urlPath = context.path.substring(1);
    for (const { file, type } of publicFiles) {
        if (urlPath === file) {
            context.type = type;
            context.body = createReadStream(path.join(rootDir, file));
            return;
        }
    }

    return next();
});

// Serve client assets
koa.use(async (context, next) => {
    const info = extract(context.path);
    if (!info) {
        error('Unknown URL', chalk.dim(context.path));
        return;
    }

    const urlPath = info.endpoint === '/' ? 'index.html' : info.endpoint.substring(1);
    const file = zip.files[urlPath];
    if (!file) {
        return next();
    }

    // Check cached response based on zip file modification
    context.lastModified = lastModified;
    if (context.fresh) {
        return;
    }

    // Rewrite various payloads
    context.body = await (async function () {
        if (urlPath === 'index.html') {
            let body = await file.async('text');
            // Inject startup shim
            const header = '<title>Screeps</title>';
            body = body.replace(header, generateScript(info.backend) + header);
            // Remove tracking pixels
            body = body.replace(
                /<script[^>]*>[^>]*xsolla[^>]*<\/script>/g,
                '<script>xnt = new Proxy(() => xnt, { get: () => xnt })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*facebook[^>]*<\/script>/g,
                '<script>fbq = new Proxy(() => fbq, { get: () => fbq })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*google[^>]*<\/script>/g,
                '<script>ga = new Proxy(() => ga, { get: () => ga })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*mxpnl[^>]*<\/script>/g,
                '<script>mixpanel = new Proxy(() => mixpanel, { get: () => mixpanel })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*twttr[^>]*<\/script>/g,
                '<script>twttr = new Proxy(() => twttr, { get: () => twttr })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*onRecaptchaLoad[^>]*<\/script>/g,
                '<script>function onRecaptchaLoad(){}</script>',
            );
            return body;
        } else if (urlPath === 'config.js') {
            const history = argv.backend ? '/room-history/' : `/(${info.backend})/room-history/`;
            const api = argv.backend ? '/api/' : `/(${info.backend})/api/`;
            const socket = argv.backend ? '/socket/' : `/(${info.backend})/socket/`;
            // Screeps server config
            return `
                var HISTORY_URL = '${history}';
                var API_URL = '${api}';
                var WEBSOCKET_URL = '${socket}';
                var CONFIG = {
                    API_URL,
                    HISTORY_URL,
                    WEBSOCKET_URL,
                    PREFIX: '',
                    IS_PTR: false,
                    DEBUG: false,
                    XSOLLA_SANDBOX: false,
                };
            `;
        } else if (context.path.endsWith('.js')) {
            let text = await file.async('text');
            if (urlPath === 'build.min.js') {
                // Load backend info from underlying server
                const backend = new URL(info.backend);
                const version = await (async function () {
                    try {
                        const response = await fetch(`${argv.internal_backend ?? info.backend}/api/version`);
                        return JSON.parse(await response.text());
                    } catch (err) {}
                })();
                const officialLike =
                    version?.serverData?.features?.some(
                        (f: { name: string }) => f.name.toLowerCase() === 'official-like',
                    ) ?? false;
                const official = backend.hostname === 'screeps.com' || officialLike;

                // Look for server options payload in build information
                for (const match of text.matchAll(/\boptions=\{/g)) {
                    for (let i = match.index!; i < text.length; ++i) {
                        if (text.charAt(i) === '}') {
                            try {
                                const payload = text.substring(match.index!, i + 1);
                                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                                const holder = new Function(payload);
                                if (payload.includes('apiUrl')) {
                                    // Inject `host`, `port`, and `official`
                                    text = `${text.substring(0, i)},
                                        host: ${JSON.stringify(backend.hostname)},
                                        port: ${backend.port || '80'},
                                        official: ${official},
                                    } ${text.substring(i + 1)}`;
                                }
                                break;
                            } catch (err) {}
                        }
                    }
                }
                if (backend.hostname !== 'screeps.com') {
                    // Replace room-history URL
                    const historyUrl =
                        `http://${host}:${port}` + (argv.backend ? '' : `/(${info.backend})`) + '/room-history';
                    text = text.replace(
                        /http:\/\/"\+s\.options\.host\+":"\+s\.options\.port\+"\/room-history/g,
                        historyUrl,
                    );

                    // Replace official CDN with local assets
                    text = text.replace(/https:\/\/d3os7yery2usni\.cloudfront\.net/g, `${info.backend}/assets`);
                }
            }
            return beautify ? jsBeautify(text) : text;
        } else {
            // JSZip doesn't implement their read stream correctly and it causes EPIPE crashes. Pass it
            // through a no-op transform stream first to iron that out.
            const stream = new Transform();
            stream._transform = function (chunk, encoding, done) {
                this.push(chunk, encoding);
                done();
            };
            file.nodeStream().pipe(stream);
            return stream;
        }
    })();

    // Set content type
    context.set(
        'Content-Type',
        {
            '.css': 'text/css',
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.map': 'application/json',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ttf': 'font/ttf',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
        }[/\.[^.]+$/.exec(urlPath.toLowerCase())?.[0] ?? '.html']!,
    );

    // We can safely cache explicitly-versioned resources forever
    if (context.request.query.bust) {
        context.set('Cache-Control', 'public,max-age=31536000,immutable');
    }
});

// Proxy API requests to Screeps server
koa.use(async (context, next) => {
    if (context.header.upgrade) {
        context.respond = false;
        return;
    }

    const info = extract(context.url);
    if (info) {
        context.respond = false;
        context.req.url = info.endpoint;
        if (info.endpoint.startsWith('/api/auth')) {
            const returnUrl = encodeURIComponent(info.backend);
            const separator = info.endpoint.endsWith('?') ? '' : info.endpoint.includes('?') ? '&' : '?';
            context.req.url = `${info.endpoint}${separator}returnUrl=${returnUrl}`;
        }
        proxy.web(context.req, context.res, {
            target: argv.internal_backend ?? info.backend,
        });
        return;
    }
    return next();
});

// Proxy WebSocket requests
server.on('upgrade', (req, socket, head) => {
    const info = extract(req.url!);
    if (info && req.headers.upgrade?.toLowerCase() === 'websocket') {
        req.url = info.endpoint;
        proxy.ws(req, socket, head, {
            target: argv.internal_backend ?? info.backend,
        });
        socket.on('error', (err) => error(err));
    } else {
        socket.end();
    }
});

// Clean up on exit
const cleanup = () => process.exit(1);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => server.close());

// Log server information
console.log('🌐', chalk.dim('Ready --'), chalk.white(`http://${host}:${port}/`));
