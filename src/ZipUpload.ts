import _ from 'lodash'
import fs from 'fs-extra'
import { zip } from 'zip-a-folder'
import moment from 'moment'
import ChatBot from 'dingtalk-robot-sender'

import Uploader from 'simple-sftp-uploader'
import { SftpUploaderOptions } from 'simple-sftp-uploader/dist/SftpUploader'

export default class ZipUpload {
  /**
   * 上传器
   */
  private _uploader: Uploader

  /**
   * 远程路径
   */
  private _remoteDir: string

  /**
   * 应用名称
   */
  private _app: string

  /**
   * 压缩目标文件夹
   */
  private _zipTargetDir: string

  /**
   * 压缩文件存放目录
   */
  private _zipFileDir: string

  /**
   * 下载服务器链接
   */
  private _host: string

  /**
   * 版本号填充 0 的个数
   */
  private _fill: number

  /**
   * 钉钉连接信息
   */
  private _dingTalk = {
    accessToken: '',
    secret: ''
  }

  /**
   * 钉钉推送消息内容
   */
  private _cardInfo: CardInfo

  /**
   * 今天 moment 对象
   */
  private _today = moment()

  constructor(options: ZipUploadOptions) {
    this._uploader = new Uploader(options.sftpOptions)

    this._remoteDir = options.sftpOptions.remoteDir

    this._cardInfo = options.cardInfo
    this._dingTalk = options.dingTalk

    this._app = options.app

    this._zipTargetDir = options.zipTargetDir
    this._zipFileDir = options.zipFileDir

    this._host = /\/$/.test(options.host) ? options.host : `${options.host}/`
    this._fill = options.fill || 2
  }

  // Webpack 钩子
  apply(compiler: any) {
    // 打包完成后
    compiler.hooks.done.tapAsync(
      'ZipUploadPlugin',
      async (compilation: any, callback: () => any) => {
        callback()
        // production 才会触发插件
        if (compiler.options.mode === 'production') {
          console.log(`[SimpleZipUpload]: Actived`)
          await this.start()
        }
      }
    )
  }

  async start() {
    let fileCount = 1

    const fileNameReg = new RegExp(`^${this._app}-${this._today.format('YYYYMMDD')}\\d{${this._fill}}\\.zip`)
    const excludeReg = new RegExp(`${this._today.format('YYYYMMDD')}\\d+\\.zip`)

    // 创建目录结构
    if (!fs.existsSync(this._zipFileDir)) {
      fs.ensureDirSync(this._zipFileDir)
    } else {
      // 查找同 app 同时间的压缩包
      const files = fs.readdirSync(this._zipFileDir)
      _.forEach(files, (file) => {
        if (fileNameReg.test(file)) {
          fileCount++
        } else if (!excludeReg.test(file)) {
          fs.unlinkSync(`${this._zipFileDir}/${file}`)
        }
      })
    }

    // 第几次上传
    const times = _.padStart(`${fileCount}`, this._fill, '0')

    // 当前版本 日期 + times
    const version = `${this._today.format('YYYYMMDD')}${times}`
    // 文件名
    const filename = `${this._app}-${version}.zip`
    // 本地 zip 路径
    const zipPath = `${this._zipFileDir}/${filename}`

    // 文件夹不存在 || 不是个文件夹
    if (!fs.existsSync(this._zipTargetDir) || !fs.statSync(this._zipTargetDir).isDirectory()) {
      console.log('文件夹不存在')
      return
    }

    console.log('开始压缩')
    await zip(this._zipTargetDir, zipPath)

    console.log('开始上传文件')

    // 连接 SFTP
    await this._uploader.connect()

    // 清空远程文件夹内容，过滤当天的上传
    await this._uploader.deleteFiles(this._remoteDir, excludeReg)

    // 执行上传
    await this._uploader.uploadFile(zipPath, `${this._remoteDir}/${filename}`)

    // 关闭连接
    this._uploader.close()

    // 文件信息（获取文件大小）
    const fileStat = fs.statSync(zipPath)

    // 上传结束 开始发送钉钉消息
    const robot = new ChatBot({
      webhook: `https://oapi.dingtalk.com/robot/send?access_token=${this._dingTalk.accessToken}`,
      accessToken: this._dingTalk.accessToken,
      secret: this._dingTalk.secret
    } as any)

    const card: ActionCard = {
      title: '',
      text: `### ${this._cardInfo.title}

<span style="color: #ccc;">${this._cardInfo.subTitle}</span>

---

${this.getBody({
        version,
        size: `${(fileStat.size / 1024 / 1024).toFixed(2)}M`,
        date: this._today.format('YYYY-MM-DD HH:mm:ss')
      })}
`,
      hideAvatar: '0',
      btnOrientation: '0',
      btns: [
        {
          title: '下载',
          actionURL: `${this._host}${filename}`
        }
      ]
    }

    robot.actionCard(card)
  }

  /**
   * 获取
   * @param cardBody
   * @returns 
   */
  getBody(cardBody: CardBody) {
    if (this._cardInfo.body) {
      if (_.isFunction(this._cardInfo.body)) {
        return this._cardInfo.body(cardBody)
      }

      return this._cardInfo.body
    }

    return `\`\`\`
版本 ${cardBody.version}
大小 ${cardBody.size}
打包日期 ${cardBody.date}
\`\`\``}

}

type CardBody = {
  /**
   * 版本
   * 
   * 例：20221027005
   */
  version: string

  /**
   * 压缩包大小
   * 
   * 例：1.00M
   */
  size: string

  /**
   * 打包时间
   * 
   * 例：2022-10-27 23:57:31
   */
  date: string
}

export type ActionCard = {
  title: string
  text: string
  singleTitle?: string
  singleURL?: string
  hideAvatar: '0' | '1'
  btnOrientation: '0' | '1'
  btns?: Array<{
    title: string
    actionURL: string
  }>
}

export type ZipUploadOptions = {
  /**
   * SFTP 连接配置
   */
  sftpOptions: SftpUploaderOptions

  /**
   * 应用名称
   * 
   * 必须是唯一的，作为压缩包前缀
   */
  app: string

  /**
   * 需要压缩的文件夹
   */
  zipTargetDir: string

  /**
   * 压缩包存放文件夹
   */
  zipFileDir: string

  /**
   * 下载服务器链接
   */
  host: string

  /**
   * 版本号填充 0 的个数
   */
  fill?: number

  /**
   * 钉钉推送消息内容
   */
  cardInfo: CardInfo

  /**
   * 钉钉机器人配置
   */
  dingTalk: {
    accessToken: string
    secret: string
  }
}

export type CardInfo = {
  /**
   * 标题
   */
  title: string

  /**
   * 子标题
   */
  subTitle: string

  /**
   * 主体内容
   * 
   * @default
   * ```
   * 版本 20221027005
   * 大小 1.00M
   * 打包日期 2022-10-27 23:57:31
   * ```
   */
  body?: string | ((cardBody: CardBody) => string)
}

export { }
