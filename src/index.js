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
  staticFile: new Map(), // 静态资源文件
  caches: new Set(),     // 文件缓存
  globalUsingComponents: {}    // app.json中定义的组件
}

async function builder (dir) {
  GLOBAL_FILE.staticFile = getStaticFiles(dir)
  const appJson = path.join(dir, 'app.json')
  compileFile(path.join(dir, 'sitemap.json'), 'root')
  compileFile(appJson, 'root')
  compileFile(changeFileExt(appJson, '.js'), 'root')
  compileFile(changeFileExt(appJson, '.wxss'), 'root')
  checkUsingComponents(GLOBAL_FILE.globalUsingComponents, appJson)
  copyStaticFiles()
}

async function compileFile(file, type) {
  if (GLOBAL_FILE.caches.has(file)) {
    return
  }
  GLOBAL_FILE.caches.add(file)
  const ext = path.extname(file)
  if (ext === '.wxss') {
    await cssCompile(file, type)
  } else if (ext === '.js' || ext === '.wxs') {
    await jsCompile(file)
  } else if (ext === '.json') {
    await jsonCompile(file)
  } else if (ext === '.wxml') {
    await wxmlCompile(file, type)
  }
}

function wxmlCompile (file, type) {
  const content = fs.readFileSync(file, 'utf8').toString()
  const v = new WxmlVisitor(file, type)
  try {
    antlrv4_js_html.transform(content, v)
  } catch (error) {
    warringLog(`${path.relative(config.dir, file)} 编译失败`, 'warring')
  }
  checkUsingComponents(v.usingComponents, file)
  saveFile(file, null)
}

// 根据json递归获取全部页面与组件
async function jsonCompile (file) {
  if (!fs.existsSync(file)) {
    warringLog(`${path.relative(config.dir, file)} 不存在`, 'error')
    return
  }
  const res = fs.readJSONSync(file)
  if (path.relative(config.dir, file) === 'app.json') {
    lazyCodeLoading(res['lazyCodeLoading'] || null)
    GLOBAL_FILE.globalUsingComponents = res.usingComponents || {}
  }
  saveFile(file, null)
  const pages = res.pages || []
  const usingComponents = res.usingComponents || {}
  const subpackages = res['subpackages'] || res['Subpackages'] || res['subPackages'] || []
  while (pages.length) {
    const item = pages.pop()
    const p = getWxFile(item, '.js')
    saveJsonFile(p, file, item, 'root')
  }
  for (const key in usingComponents) {
    const item = usingComponents[key]
    const p = getWxFile(path.resolve(path.dirname(file), item) + '.js', false)
    saveJsonFile(p, file, item, 'root')
  }
  buildSubpackages(subpackages, file)
}

// 分包页的处理
function buildSubpackages (subpackages, file) {
  while (subpackages.length) {
    const ele = subpackages.pop()
    const root = ele.root || ele.name
    const pages = ele.pages || []
    while (pages.length) {
      const page = pages.pop()
      const item = path.join(root, page)
      const p = getWxFile(item, '.js')
      saveJsonFile(p, file, item, 'subpackages')
    }
  }
}

// 保存json文件
function saveJsonFile (p, file, item, type) {
  if (!p) { 
    warringLog(`请优化该路径来节约编译时间: ${item}, 来源: ${path.relative(config.dir, file)}`, 'error') 
  } else {
    compileFile(p, type)
    compileFile(changeFileExt(p, '.json'), type)
    compileFile(changeFileExt(p, '.wxml'), type)
    compileFile(changeFileExt(p, '.wxss'), type)
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
      if ((fs.statSync(ele).size / 1024).toFixed(0) > 200) {
        warringLog(`${path.relative(config.dir, ele)} 文件大于200k`, 'error')
      } else {
        let distPath = getDistPath(ele)
        fs.ensureFileSync(distPath)
        fs.createReadStream(ele).pipe(fs.createWriteStream(distPath))
      }
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
  if ((fs.statSync(file).size / 1024).toFixed(0) > 200) {
    return true
  }
  return false
}

// 检查js模块引入方式是否存在: 非相对路径的情况
function checkJsFilePath (p, source) {
  let file = path.join(path.dirname(source), p)
  if (!file.endsWith('.js')) {
    file += '.js'
  }
  if (fs.existsSync(file)) {
    compileFile(file, undefined)
  } else {
    warringLog(`请优化该js的引入路径来节约编译时间: ${p}, 来源: ${path.relative(config.dir, source)}`, 'error')
  }
}

async function cssCompile (file, type) {
  if (!fs.existsSync(file)) {
    return
  }
  const content = fs.readFileSync(file, 'utf8').toString()
  const v = new CssVisitor(config.css, 'wx-', file, type)
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
      if (!['.js', '.json', '.wxml', '.wxss', '.md', '.wxs'].includes(ext) && 
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

// 提示组件没有被页面使用
function checkUsingComponents (components, file) {
  for (const key in components) {
    warringLog(`${path.relative(config.dir, changeFileExt(file, '.json'))} 中组件: ${key} 没有被使用`, 'error')
  }
}

function lazyCodeLoading (lazyCodeLoading) {
  if (!lazyCodeLoading) {
    warringLog(`未开启未开启组件懒注入属性: lazyCodeLoading`, 'error')
  }
}

class CssVisitor extends css.Visitor {
  constructor(css, key, sourceFile, type) {
    super()
    this.sub = type
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
      compileFile(path.join(path.dirname(this.sourceFile), file), this.sub)
    }
    this.code += node.getText()
  }
}

class WxmlVisitor extends antlrv4_js_html.Visitor {
  constructor(file, type) {
    super()
    this.sub = type // 是否是主包
    this.sourceFile = file
    this.usingComponents = {}
    const jsonFile = changeFileExt(file, '.json')
    if (fs.existsSync(jsonFile)) {
      this.usingComponents = fs.readJsonSync(jsonFile).usingComponents || {}
    }
  }

  visitHtmlElement(ctx) {
    const tag = ctx.TAG_NAME()[0].getText()
    if (this.usingComponents[tag]) {
      delete this.usingComponents[tag]
    } else if (GLOBAL_FILE.globalUsingComponents[tag]) {
      if (this.sub === 'subpackages') {
        warringLog(`${path.relative(config.dir, this.sourceFile)} 中组件${tag}: 在主包中未使用,请移动到分包中`, 'error')
      }
      delete GLOBAL_FILE.globalUsingComponents[tag]
    }
    ctx.htmlAttribute().forEach(attr => {
      const children = attr.children
      if (children.length > 1) {
        const key = children[0].getText()
        const val = children[2].getText()
        if (!removeMark(val)) {
          warringLog(`请添加'${key}'的值, 来源: ${path.relative(config.dir, this.sourceFile)}`, 'warring')
        } else {
          this.checkStaticPath(key, val, tag)
        }
      }
    })
    return this.visitChildren(ctx)
  }

  checkStaticPath(key, val, tag) {
    if (key === 'src') {
      const value = removeMark(val)
      const expression = /http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/
      const file = path.join(path.dirname(this.sourceFile), value)
      this.wxsCheck(tag, file)
      this.wxmlCheck(tag, file)
      if (!expression.test(value) && !value.includes('{') && !fs.existsSync(file)
        && !fs.existsSync(path.join(config.dir, value))) {
        warringLog(`${val}不存在, 来源: ${path.relative(config.dir, this.sourceFile)}`, 'error')
      }
    }
  }
  //编译wxs路径的文件
  wxsCheck (tag, file) {
    if (tag !== 'wxs') {
      return
    }
    compileFile(file, this.sub)
  }
  //编译wxml路径的文件
  wxmlCheck (tag, file) {
    if (tag === 'import' || tag === 'include') {
      compileFile(file, this.sub)
    }
  }
}

module.exports = {
  main: main
}
