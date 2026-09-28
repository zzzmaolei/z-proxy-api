/** 应用启动入口 — PM2 cluster 模式进程管理 */

const cluster = require('cluster')
const os = require('os')
const { logger } = require('./utils/logger')

// 加载环境变量
require('dotenv').config()

// 获取CPU核心数
const cpuCores = os.cpus().length

// 获取环境变量配置
const PM2_INSTANCES = process.env.PM2_INSTANCES || '1'
const SERVICE_PORT = process.env.SERVICE_PORT || 3000
const NODE_ENV = process.env.NODE_ENV || 'production'
// direct Node cluster 只在显式打开时启用。
// 生产多进程推荐交给 PM2；否则 npm start + PM2_INSTANCES>1 会在 Windows/WSL
// 场景里反复抢同一个端口，表现为 worker 退出、重启、日志刷屏。
const ENABLE_NODE_CLUSTER = ['1', 'true', 'yes', 'on'].includes(String(process.env.ENABLE_NODE_CLUSTER || '').toLowerCase())

// 解析进程数
let instances
if (PM2_INSTANCES === 'max') {
  instances = cpuCores
} else if (!isNaN(PM2_INSTANCES)) {
  instances = parseInt(PM2_INSTANCES)
} else {
  instances = 1
}

// PM2_INSTANCES='0' 时 instances=0，会导致 cluster 模式下 for 循环不执行、服务挂起
if (instances < 1) instances = 1

// 限制进程数不能超过CPU核心数
if (instances > cpuCores) {
  logger.warn(`配置的进程数(${instances})超过CPU核心数(${cpuCores})，自动调整为${cpuCores}`, 'AUTO')
  instances = cpuCores
}

logger.info('🚀 z.proxy.api 智能启动', 'AUTO')
logger.info(`CPU核心数: ${cpuCores}`, 'AUTO')
logger.info(`配置的进程数: ${PM2_INSTANCES}`, 'AUTO')
logger.info(`解析后的进程数: ${instances}`, 'AUTO')
logger.info(`服务端口: ${SERVICE_PORT}`, 'AUTO')

// 智能判断启动方式
if (instances === 1) {
  logger.info('📦 使用单进程模式启动', 'AUTO')
  // 直接启动服务器
  require('./server.js')
} else {
  // 检查是否通过PM2启动
  if (process.env.PM2_USAGE || process.env.pm_id !== undefined) {
    logger.info(`PM2进程启动 - 进程ID: ${process.pid}, 工作进程ID: ${process.env.pm_id || 'unknown'}`, 'PM2')
    require('./server.js')
  } else if (!ENABLE_NODE_CLUSTER) {
    logger.warn(`PM2_INSTANCES=${PM2_INSTANCES} 但当前不是 PM2 托管；npm start 默认使用单进程，避免 direct cluster 抢占端口导致重启风暴。需要 direct cluster 时设置 ENABLE_NODE_CLUSTER=true。`, 'AUTO')
    require('./server.js')
  } else if (cluster.isMaster) {
    logger.info(`🔥 使用Node.js集群模式启动 (${instances}个进程)`, 'AUTO')

    logger.info(`启动主进程 - PID: ${process.pid}`, 'CLUSTER')
    logger.info(`运行环境: ${NODE_ENV}`, 'CLUSTER')

    // 创建工作进程
    for (let i = 0; i < instances; i++) {
      const worker = cluster.fork()
      logger.info(`启动工作进程 ${i + 1}/${instances} - PID: ${worker.process.pid}`, 'CLUSTER')
    }

    let isShuttingDown = false
    // 重启风暴保险丝：worker 连续快速退出通常不是业务失败，而是端口被占用、
    // Redis/配置初始化异常等系统性问题。继续 fork 只会把日志刷爆，所以超过阈值
    // 后进入统一关闭流程，把真正错误留在前面的日志里。
    const fastExitTimes = []
    const fastExitWindowMs = 10000
    const maxFastExits = Math.max(instances * 2, 6)
    const shutdownCluster = (signalName) => {
      if (isShuttingDown) return
      isShuttingDown = true
      logger.info(`收到${signalName}信号，正在优雅关闭...`, 'CLUSTER')
      const forceExitTimer = setTimeout(() => {
        logger.warn(`集群关闭超时，强制退出 (${signalName})`, 'CLUSTER')
        process.exit(0)
      }, 10000)
      if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref()
      cluster.disconnect(() => {
        clearTimeout(forceExitTimer)
        process.exit(0)
      })
    }

    // 监听工作进程退出
    cluster.on('exit', (worker, code, signal) => {
      logger.error(`工作进程 ${worker.process.pid} 已退出 - 退出码: ${code}, 信号: ${signal}`, 'CLUSTER')

      // 自动重启工作进程
      if (!isShuttingDown && !worker.exitedAfterDisconnect) {
        const now = Date.now()
        fastExitTimes.push(now)
        while (fastExitTimes.length > 0 && now - fastExitTimes[0] > fastExitWindowMs) {
          fastExitTimes.shift()
        }
        if (fastExitTimes.length > maxFastExits) {
          logger.error(`工作进程在 ${fastExitWindowMs}ms 内连续退出 ${fastExitTimes.length} 次，停止重启以避免刷屏。请检查端口 ${SERVICE_PORT} 是否被占用。`, 'CLUSTER')
          shutdownCluster('worker-restart-storm')
          return
        }
        logger.info('正在重启工作进程...', 'CLUSTER')
        const newWorker = cluster.fork()
        logger.info(`新工作进程已启动 - PID: ${newWorker.process.pid}`, 'CLUSTER')
      }
    })

    // 监听工作进程在线
    cluster.on('online', (worker) => {
      logger.info(`工作进程 ${worker.process.pid} 已上线`, 'CLUSTER')
    })

    // 监听工作进程断开连接
    cluster.on('disconnect', (worker) => {
      logger.warn(`工作进程 ${worker.process.pid} 已断开连接`, 'CLUSTER')
    })

    // 优雅关闭处理
    process.on('SIGTERM', () => shutdownCluster('SIGTERM'))
    process.on('SIGINT', () => shutdownCluster('SIGINT'))

  } else {
    // 工作进程逻辑
    logger.info(`工作进程启动 - PID: ${process.pid}`, 'WORKER')
    require('./server.js')

    // 工作进程优雅关闭处理
    process.on('SIGTERM', () => {
      logger.info(`工作进程 ${process.pid} 收到SIGTERM信号，正在关闭...`, 'WORKER')
      process.exit(0)
    })

    process.on('SIGINT', () => {
      logger.info(`工作进程 ${process.pid} 收到SIGINT信号，正在关闭...`, 'WORKER')
      process.exit(0)
    })

    // 防止未处理的异常导致工作进程崩溃
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`工作进程 ${process.pid} 未处理的 Promise 拒绝: ${reason}`, 'WORKER')
    })

    process.on('uncaughtException', (error) => {
      logger.error(`工作进程 ${process.pid} 未捕获的异常: ${error.message}`, 'WORKER', error)
      // 延迟退出，让日志写入后由 PM2 重启
      setTimeout(() => process.exit(1), 1000)
    })
  }
}
