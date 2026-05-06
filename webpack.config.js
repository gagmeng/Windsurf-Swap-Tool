// webpack.config.js - WF Switcher 打包配置 (高强度混淆版)
// 开发者: Ti
'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const WebpackObfuscator = require('webpack-obfuscator');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'production',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          compress: {
            passes: 3,
            toplevel: true,
            pure_getters: true,
            unsafe: true,
            unsafe_arrows: true,
            unsafe_methods: true,
            drop_debugger: true,
            hoist_funs: true,
            hoist_vars: false,
            dead_code: true,
            unused: true
          },
          mangle: {
            toplevel: true,
            reserved: [
              'exports', 'module', 'require', '__webpack_require__',
              'vscode', 'activate', 'deactivate'
            ]
          },
          format: {
            comments: false,
            beautify: false,
            ascii_only: true
          },
          ecma: 2020,
          sourceMap: false
        },
        extractComments: false,
        parallel: true
      })
    ]
  },
  plugins: [
    new WebpackObfuscator({
      /* ===== 标识符混淆 ===== */
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: true,
      renameProperties: false,         /* 属性名不改, 避免炸掉 vscode API 调用 */
      identifiersDictionary: [],

      /* ===== 字符串加密 (核心!) ===== */
      stringArray: true,               /* 提取所有字符串到数组 + 索引访问 */
      stringArrayThreshold: 0.8,       /* 80% 的字符串会被加密 */
      stringArrayEncoding: ['rc4'],    /* RC4 加密字符串 (最强, base64 其次) */
      stringArrayRotate: true,         /* 数组旋转打乱顺序 */
      stringArrayShuffle: true,        /* 启动时随机 shuffle */
      stringArrayWrappersCount: 3,     /* 多层 wrapper 函数, 增加反混淆难度 */
      stringArrayWrappersType: 'function',
      stringArrayWrappersChainedCalls: true,
      stringArrayCallsTransform: true, /* 调用方式变换 */
      stringArrayCallsTransformThreshold: 0.6,
      splitStrings: true,              /* 长字符串拆成碎片再拼接 */
      splitStringsChunkLength: 6,
      unicodeEscapeSequence: true,     /* 字符串用 unicode 转义 */

      /* ===== 控制流混淆 ===== */
      controlFlowFlattening: true,     /* 控制流平坦化 — switch-case 替代 if-else */
      controlFlowFlatteningThreshold: 0.6,
      deadCodeInjection: true,         /* 注入不可达的垃圾代码干扰 */
      deadCodeInjectionThreshold: 0.3,

      /* ===== 反调试 / 自我保护 ===== */
      selfDefending: true,             /* 格式化检测: 一旦 beautify 就炸 */
      debugProtection: false,          /* 不开 debugger 循环, 避免影响 VSCode DevTools */
      disableConsoleOutput: false,     /* 保留 console (用户需要日志排错) */

      /* ===== 其他 ===== */
      compact: true,
      simplify: true,
      numbersToExpressions: true,      /* 数字常量变表达式 */
      transformObjectKeys: true,       /* 对象 key 转计算属性 */
      target: 'node',
      seed: 0,                         /* 每次构建随机种子不同 */
      sourceMap: false,
      ignoreImports: true              /* 不动 require/import 路径 */
    }, [])                             /* 第二参数: 排除的文件 glob, 空 = 全部混淆 */
  ],
  devtool: false,
  infrastructureLogging: {
    level: 'log'
  }
};

module.exports = config;
