# weapp_fc
### 微信小程序静态扫描
##### 该项目有啥用: 协助小程序开发者优化项目
-----
### 执行
```bash
$ npm i weapp_fc -g

$ mkdir dist

$ cd dist

$ weapp_fc - d 小程序目录
```

### 检查功能

- js模块引入路径是否为相对路径
- css @import路径
- 空文件
- wxml中属性为空
- wxml中src属性的value如果是文件判断其是否存在
- 静态资源文件是否被使用(不是很准确,控制台提示之后可以自查一遍提示的文件是否被使用)
- 静态资源文件大于200k
- 存在无使用的组件
- 主包存在仅被其他分包依赖的组件
- 未开启组件懒注入

### 未实现功能
+ 想到的都已经实现了, 有需求可以自己pr或者issues


### [个人博客](https://www.yuque.com/anruofusheng/bytlpr/gewztp)