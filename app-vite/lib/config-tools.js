
const { mergeConfig } = require('vite')
const { quasar: quasarVitePlugin } = require('@quasar/vite-plugin')
const vueVitePlugin = require('@vitejs/plugin-vue')
const getPackage = require('./helpers/get-package')
const { merge } = require('webpack-merge')
const { removeSync } = require('fs-extra')

const appPaths = require('./app-paths')
const parseEnv = require('./parse-env')
const { log } = require('./helpers/logger')
const extensionRunner = require('./app-extension/extensions-runner')

const quasarVitePluginIndexHtmlTransform = require('./plugins/vite.index-html-transform')

const { dependencies:cliDepsObject } = require(appPaths.resolve.cli('package.json'))
const appPkgFile = appPaths.resolve.app('package.json')
const cliDeps = Object.keys(cliDepsObject)

function printInvalidSyntax (name) {
  console.error('[Quasar CLI] quasar.config.js > invalid Vite plugin specified:', name)
  console.error(`Correct form: [ 'my-vite-plugin-name', { /* opts */ } ]`)
}

function parseVitePlugins (entries) {
  const acc = []

  entries.forEach(entry => {
    if (!entry) {
      // example:
      // [
      //   ctx.dev ? [ ... ] : null,
      //   // ...
      // ]
      return
    }

    if (Array.isArray(entry) === false) {
      printInvalidSyntax(name)
      return
    }

    const [ name, opts ] = entry

    if (typeof name === 'function') {
      acc.push(name(opts))
      return
    }

    if (typeof name !== 'string') {
      printInvalidSyntax(name)
      return
    }

    const plugin = getPackage(name)

    if (!plugin) {
      console.error('[Quasar CLI] quasar.config.js > invalid Vite plugin specified (cannot find it):', name)
      return
    }

    acc.push((plugin.default || plugin)(opts))
  })

  return acc
}

function createViteConfig (quasarConf, quasarRunMode) {
  const { ctx, build } = quasarConf
  const cacheSuffix = quasarRunMode || ctx.modeName
  const cacheDir = appPaths.resolve.app(`node_modules/.q-cache/vite/${ cacheSuffix }`)

  if (quasarConf.build.rebuildCache === true) {
    removeSync(cacheDir)
  }

  const vueVitePluginOptions = quasarRunMode !== 'ssr-server'
    ? build.viteVuePluginOptions
    : merge({
        ssr: true,
        template: { ssr: true }
      }, build.viteVuePluginOptions)

  const viteConf = {
    configFile: false,
    root: appPaths.appDir,
    base: build.publicPath,
    publicDir: build.ignorePublicFolder === true
      ? false
      : appPaths.publicDir,
    clearScreen: false,
    logLevel: 'warn',
    mode: ctx.dev === true ? 'development' : 'production',
    cacheDir,

    resolve: build.resolve,
    define: parseEnv(build.env, build.rawDefine),

    build: {
      target: quasarRunMode === 'ssr-server'
        ? build.target.node
        : build.target.browser,
      polyfillModulePreload: build.polyfillModulePreload,
      emptyOutDir: false,
      minify: build.minify,
      sourcemap: build.sourcemap === true
        ? 'inline'
        : build.sourcemap || false
    },

    optimizeDeps: {
      entries: [ 'index.html' ]
    },

    plugins: [
      vueVitePlugin(vueVitePluginOptions),
      quasarVitePlugin({
        runMode: quasarRunMode || 'web-client',
        autoImportComponentCase: quasarConf.framework.autoImportComponentCase,
        sassVariables: quasarConf.metaConf.css.variablesFile
      }),
      ...parseVitePlugins(build.vitePlugins)
    ]
  }

  if (
    quasarRunMode !== 'ssr-server'
    && (quasarRunMode !== 'ssr-client' || quasarConf.ctx.prod === true)
  ) {
    viteConf.plugins.unshift(
      quasarVitePluginIndexHtmlTransform(quasarConf)
    )
  }

  if (ctx.dev) {
    viteConf.server = quasarConf.devServer
  }
  else {
    viteConf.build.outDir = build.distDir

    const analyze = quasarConf.build.analyze
    if (analyze) {
      viteConf.plugins.push(
        require('rollup-plugin-visualizer').visualizer({
          open: true,
          filename: `.quasar/stats-${ quasarRunMode }.html`,
          ...(Object(analyze) === analyze ? analyze : {})
        })
      )
    }
  }

  if (quasarRunMode !== 'ssr-server') {
    const { warnings, errors } = quasarConf.eslint
    if (warnings === true && errors === true) {
      // require only if actually needed (as it imports app's eslint pkg)
      const quasarVitePluginESLint = require('./plugins/vite.eslint')
      viteConf.plugins.push(
        quasarVitePluginESLint(quasarConf, { cacheSuffix })
      )
    }
  }

  return viteConf
}

function extendViteConfig (viteConf, quasarConf, invokeParams) {
  const opts = {
    isClient: false,
    isServer: false,
    ...invokeParams
  }

  if (typeof quasarConf.build.extendViteConf === 'function') {
    quasarConf.build.extendViteConf(viteConf, opts)
  }

  const promise = extensionRunner.runHook('extendViteConf', async hook => {
    log(`Extension(${hook.api.extId}): Extending Vite config`)
    await hook.fn(viteConf, opts, hook.api)
  })

  return promise.then(() => viteConf)
}

function createNodeEsbuildConfig (quasarConf, getLinterOpts) {
  // fetch fresh copy; user might have installed something new
  delete require.cache[appPkgFile]
  const { dependencies:appDeps = {}, devDependencies:appDevDeps = {} } = require(appPkgFile)

  const cfg = {
    platform: 'node',
    target: quasarConf.build.target.node,
    format: 'cjs',
    bundle: true,
    sourcemap: quasarConf.metaConf.debugging === true ? 'inline' : false,
    external: [
      ...cliDeps,
      ...Object.keys(appDeps),
      ...Object.keys(appDevDeps)
    ],
    minify: quasarConf.build.minify !== false,
    define: parseEnv(quasarConf.build.env, quasarConf.build.rawDefine)
  }

  const { warnings, errors } = quasarConf.eslint
  if (warnings === true && errors === true) {
    // require only if actually needed (as it imports app's eslint pkg)
    const quasarEsbuildPluginESLint = require('./plugins/esbuild.eslint')
    cfg.plugins = [
      quasarEsbuildPluginESLint(quasarConf, getLinterOpts)
    ]
  }

  return cfg
}

function createBrowserEsbuildConfig (quasarConf, getLinterOpts) {
  const cfg = {
    platform: 'browser',
    target: quasarConf.build.target.browser,
    format: 'iife',
    bundle: true,
    sourcemap: quasarConf.metaConf.debugging === true ? 'inline' : false,
    minify: quasarConf.build.minify !== false,
    define: parseEnv(quasarConf.build.env, quasarConf.build.rawDefine)
  }

  const { warnings, errors } = quasarConf.eslint
  if (warnings === true && errors === true) {
    // require only if actually needed (as it imports app's eslint pkg)
    const quasarEsbuildPluginESLint = require('./plugins/esbuild.eslint')
    cfg.plugins = [
      quasarEsbuildPluginESLint(quasarConf, getLinterOpts)
    ]
  }

  return cfg
}

function extendEsbuildConfig (esbuildConf, quasarConfTarget, threadName) {
  const method = `extend${threadName}Conf`

  // example: quasarConf.ssr.extendSSRWebserverConf
  if (typeof quasarConfTarget[method] === 'function') {
    quasarConfTarget[method](esbuildConf)
  }

  const promise = extensionRunner.runHook(method, async hook => {
    log(`Extension(${hook.api.extId}): Extending "${threadName}" Esbuild config`)
    await hook.fn(esbuildConf, hook.api)
  })

  return promise.then(() => esbuildConf)
}

module.exports.createViteConfig = createViteConfig
module.exports.extendViteConfig = extendViteConfig
module.exports.mergeViteConfig = mergeConfig

module.exports.createNodeEsbuildConfig = createNodeEsbuildConfig
module.exports.createBrowserEsbuildConfig = createBrowserEsbuildConfig
module.exports.extendEsbuildConfig = extendEsbuildConfig
