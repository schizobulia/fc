const css = require('antlrv4-js-css')
const fs = require('fs-extra')
const path = require('path')
const traverse = require('@babel/traverse').default
const babel = require('@babel/core')
const generate = require('@babel/generator').default
const types = require('@babel/types')
const antlrv4_js_html = require('antlrv4-js-html')
const { program } = require('commander')

let config = {}
const GLOBAL_FILE = {
  staticFile: new Map(),
  caches: new Set()
}

async function builder (dir) {
  GLOBAL_FILE.staticFile = getStaticFiles(dir)
  const appJson = path.join(dir, 'app.json')
  compileFile(path.join(dir, 'sitemap.json'))
  compileFile(appJson)
  compileFile(changeFileExt(appJson, '.js'))
  compileFile(changeFileExt(appJson, '.wxss'))
  copyStaticFiles()
}

async function compileFile(file) {
  if (GLOBAL_FILE.caches.has(file)) {
    return
  }
  GLOBAL_FILE.caches.add(file)
  const ext = path.extname(file)
  if (ext === '.wxss') {
    await cssCompile(file)
  } else if (ext === '.js') {
    await jsCompile(file)
  } else if (ext === '.json') {
    await jsonCompile(file)
  } else if (ext === '.wxml') {
    await wxmlCompile(file)
  }
}

function wxmlCompile (file) {
  const content = fs.readFileSync(file, 'utf8').toString()
  const v = new WxmlVisitor(file)
  try {
    antlrv4_js_html.transform(content, v)
  } catch (error) {
    warringLog(`${path.relative(config.dir, file)} 编译失败`, 'warring')
  }
  saveFile(file, null)
}

// 根据json递归获取全部页面与组件
async function jsonCompile (file) {
  if (!fs.existsSync(file)) {
    warringLog(`${path.relative(config.dir, file)} 不存在`, 'error')
    return
  }
  const res = JSON.parse(fs.readFileSync(file, 'utf8'))
  saveFile(file, null)
  const pages = res.pages || []
  const usingComponents = res.usingComponents || {}
  const subpackages = res['subpackages'] || res['Subpackages'] || []
  while (pages.length) {
    const item = pages.pop()
    const p = getWxFile(item, '.js')
    saveJsonFile(p, file, item)
  }
  for (const key in usingComponents) {
    const item = usingComponents[key]
    const p = getWxFile(path.resolve(path.dirname(file), item) + '.js', false)
    saveJsonFile(p, file, item)
  }
  buildSubpackages(subpackages, file)
}

function buildSubpackages (subpackages, file) {
  while (subpackages.length) {
    const ele = subpackages.pop()
    const root = ele.root || ele.name
    const pages = ele.pages || []
    while (pages.length) {
      const page = pages.pop()
      const item = path.join(root, page)
      const p = getWxFile(item, '.js')
      saveJsonFile(p, file, item)
    }
  }
}

// 保存json文件
function saveJsonFile (p, file, item) {
  if (!p) { 
    warringLog(`请优化该路径来节约编译时间: ${item}, 来源: ${path.relative(config.dir, file)}`, 'error') 
  } else {
    compileFile(p)
    compileFile(changeFileExt(p, '.json'))
    compileFile(changeFileExt(p, '.wxml'))
    compileFile(changeFileExt(p, '.wxss'))
  }
}

// 修改文件后缀名
function changeFileExt (file, ext) {
  return path.join(path.dirname(file), path.parse(file).name) + ext
}

function warringLog (msg, type) {
  if (type === 'error') {
    msg = "\033[31m" + msg + "\033[0m"
  } else if (type === 'success') {
    msg = "\033[34m" + msg + "\033[0m"
  } else {
    msg = "\033[33m" + msg + "\033[0m"
  }
  console.log(msg)
}

// 获取绝对路径
function getWxFile (p, ext) {
  const files = [
    p,
    path.join(config.dir, `${p}${ext}`)
  ]
  while (files.length) {
    const file = files.pop()
    if (fs.existsSync(file)) {
      return file
    }
  }
  return null
}

function getDistPath (file) {
  let relative = path.relative(config.dir, file)
  return path.join(config.dist, relative)
}

async function saveFile (file, content) {
  const fileSize = fs.statSync(file).size
  if (fileSize === 0) {
    warringLog(`${path.relative(config.dir, file)} 文件为空`, 'error')
  } else if ((fileSize/ 1024).toFixed(0) > 1024) {
    warringLog(`${path.relative(config.dir, file)} 文件大于1M`, 'warring')
  } else {
    let distPath = getDistPath(file)
    fs.ensureFileSync(distPath)
    if (content) {
      fs.writeFileSync(distPath, content, 'utf-8')
    } else {
      content = fs.readFileSync(file, 'utf-8')
      fs.createReadStream(file).pipe(fs.createWriteStream(distPath))
    }
    checkStaticIs(content)
    warringLog(`${path.relative(config.dir, file)} 检查通过`, 'success')
  }
}

// 检查静态资源是否被使用过
function checkStaticIs (content) {
  GLOBAL_FILE.staticFile.forEach((ele, key) => {
    if(content.includes(key)) {
      let distPath = getDistPath(ele)
      fs.ensureFileSync(distPath)
      fs.createReadStream(ele).pipe(fs.createWriteStream(distPath))
      GLOBAL_FILE.staticFile.delete(key)
    }
  })
}

async function jsCompile (file) {
  if (checkModuleFileSzie(file)) {
    saveFile(file, null)
    return
  }
  const ast = await babel.transformFileSync(
    file,
    { ast: true }
  ).ast
  traverse(ast, {
    enter (astPath) {
      astPath.traverse({
        Identifier (ap) {
          if (config.js && config.js.wxKey && ap.isReferenced() && ap.node.name === config.js.wxKey) {
            ap.replaceWith(types.identifier('wx'))
          }
        }
      })
    },
    ImportDeclaration(ap) {
      checkJsFilePath(ap.node.source.extra.rawValue, file)
    },
    CallExpression(ap) {
      if (ap.node.callee.name === 'require' && ap.node.arguments) {
        const requireValue = ap.node.arguments[0].value
        checkJsFilePath(requireValue, file)
      }
    }
  })
  saveFile(file, generate(ast).code)
}

function checkModuleFileSzie (file) {
  if ((fs.statSync(file).size / 1024).toFixed(0) > 100) {
    return false
  }
  return true
}

// 检查js模块引入方式是否存在: 非相对路径的情况
function checkJsFilePath (p, source) {
  let file = path.join(path.dirname(source), p)
  if (!file.endsWith('.js')) {
    file += '.js'
  }
  if (fs.existsSync(file)) {
    compileFile(file)
  } else {
    warringLog(`请优化该js的引入路径来节约编译时间: ${p}, 来源: ${path.relative(config.dir, source)}`, 'error')
  }
}

async function cssCompile (file) {
  if (!fs.existsSync(file)) {
    return
  }
  const content = fs.readFileSync(file, 'utf8').toString()
  const v = new CssVisitor(config.css, 'wx-', file)
  try {
    css.transform(content, v)
  } catch (error) {
    warringLog(`${path.relative(config.dir, file)} 编译失败`, 'warring')
  }
  saveFile(file, v.code)
}

async function main () {
  console.time()
  program
  .option('-d, --dir <type>', '小程序目录')
  .option('-c, --config <type>', '配置文件')
  .option('-o, --out <type>', '输出目录')
  program.parse(process.argv)
  const options = program.opts()
  const configFile = options.config || path.join(process.cwd(), 'config.json')
  if (fs.existsSync(configFile)) {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } else {
    console.error('配置文件不存在')
  }
  const dir = options.dir || config.dir
  config.dist = options.out || path.join(process.cwd(), 'dist')
  fs.emptyDirSync(config.dist)
  config.dir = dir
  if (fs.statSync(dir).isDirectory()) {
    await builder(dir)
    console.timeEnd()
  } else {
    console.error('Not a directory')
  }
}

// 去除两边引号
function removeMark (text) {
  return text.substring(1, text.length-1)
}

// 获取静态资源路径
function getStaticFiles (dir) {
  const arr = new Map()
  getFileByDir(dir, arr)
  return arr
}

function getFileByDir (src, arr) {
  const dirs = fs.readdirSync(src)
  while (dirs.length) {
    const dir = dirs.pop()
    const d = path.join(src, dir)
    if (fs.statSync(d).isDirectory()) {
      if (!['.git', '.vscode', 'node_modules', 'miniprogram_npm', 'npm'].includes(dir)) {
        getFileByDir(d, arr)
      }
    } else {
      const ext = path.extname(d)
      const name = path.basename(d)
      if (!['.js', '.json', '.wxml', '.wxss', '.md'].includes(ext) && 
        !['.DS_Store', '.gitignore'].includes(name)) {
        arr.set(name, d)
      }
    }
  }
}

function copyStaticFiles () {
  GLOBAL_FILE.staticFile.forEach((ele) => {
    warringLog(`${path.relative(config.dir, ele)} 文件可能没有被使过`, 'warring')
  })
}

class CssVisitor extends css.Visitor {
  constructor(css, key, sourceFile) {
    super()
    this.code = ''
    if (css && css.wxKey) {
      this.wxKey = css.wxKey
    } else {
      this.wxKey = ''
    }
    this.key = key
    if (css && css.variable) {
      this.variable = css.variable
    } else {
      this.variable = {}
    }
    this.sourceFile = sourceFile
  }

  visitSimpleSelectorSequence(ctx) {
    let text = ctx.getText()
    if (this.wxKey && text.startsWith(this.wxKey)) {
      text = text.replace(this.wxKey, this.key)
    }
    this.code += text
  }

  visitExpr(node) {
    let text = node.getText()
    if (this.variable && this.variable[text]) {
      text = this.variable[text]
    }
    this.code += text
  }

  visitTerminal(node) {
    let text = node.getText()
    this.code += text
  }

  visitGoodImport(node) {
    let text = node.String_().getText()
    const file = removeMark(text)
    if (!file.endsWith('.wxss')) {
      warringLog(`请添加后缀名: ${text}, 来源: ${path.relative(config.dir, this.sourceFile)}`, 'error')
    } else {
      compileFile(path.join(path.dirname(this.sourceFile), file))
    }
    this.code += node.getText()
  }
}

class WxmlVisitor extends antlrv4_js_html.Visitor {
  constructor(file) {
    super()
    this.sourceFile = file
  }

  visitHtmlElement(ctx) {
    ctx.htmlAttribute().forEach(attr => {
      const children = attr.children
      if (children.length > 1) {
        const key = children[0].getText()
        const val = children[2].getText()
        if (!removeMark(val)) {
          warringLog(`请添加'${key}'的值, 来源: ${path.relative(config.dir, this.sourceFile)}`, 'warring')
        } else {
          this.checkStaticPath(key, val)
        }
      }
    })
    return this.visitChildren(ctx)
  }

  checkStaticPath(key, val) {
    if (key === 'src') {
      const value = removeMark(val)
      const expression = /http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/
      const file = path.join(path.dirname(this.sourceFile), value)
      if (!expression.test(value) && !value.includes('{') && !fs.existsSync(file)
        && !fs.existsSync(path.join(config.dir, value))) {
        warringLog(`${val}不存在, 来源: ${path.relative(config.dir, this.sourceFile)}`, 'error')
      }
    }
  }
}

module.exports = {
  main: main
}
