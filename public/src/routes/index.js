import { createRouter, createWebHistory } from 'vue-router'
import axios from 'axios'
import { getApiKey } from '../utils/auth.js'

const routes = [
  {
    name: 'dashboard',
    path: '/',
    component: () => import('../views/dashboard.vue')
  },
  {
    name: 'auth',
    path: '/auth',
    component: () => import('../views/auth.vue')
  },
  {
    name: 'settings',
    path: '/settings',
    component: () => import('../views/settings.vue')
  },
  {
    name: 'statistics',
    path: '/statistics',
    component: () => import('../views/statistics.vue')
  },
    {
    name: 'chat',
    path: '/chat',
    component: () => import('../views/chat.vue')
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})


// 验证缓存：避免每次路由切换都发网络请求（1分钟有效期）
// isAdmin 直接从 localStorage 读取，缓存只跟踪"已验证 + key 未变 + 未过期"
const verifyCache = {
  key: '',
  timestamp: 0,
  valid() {
    const k = getApiKey()
    return k && this.key === k && (Date.now() - this.timestamp) < 60000
  },
  set() {
    this.key = getApiKey()
    this.timestamp = Date.now()
  },
  clear() {
    this.key = ''
    this.timestamp = 0
  }
}

// 路由守卫
router.beforeEach(async (to, from, next) => {

  if (to.path === '/auth') {
    next()
  } else {
    const apiKey = getApiKey()
    if (!apiKey) {
      console.error('未设置 apiKey，跳转至 /auth')
      next({ path: '/auth' })
    } else {
      // 使用缓存避免每次路由切换都发网络请求
      if (verifyCache.valid()) {
        const isAdmin = localStorage.getItem('isAdmin') === 'true'
        if ((to.path === '/' || to.path === '/settings' || to.path === '/statistics') && !isAdmin) {
          console.error('非管理员用户尝试访问管理页面')
          next({ path: '/auth' })
          return
        }
        next()
        return
      }

      try {
        const verifyResponse = await axios.post('/verify', {
          apiKey: apiKey
        })

        if (verifyResponse.data.status === 200) {
          const isAdmin = verifyResponse.data.isAdmin

          // 缓存验证结果
          verifyCache.set()

          // 存储用户权限信息
          localStorage.setItem('isAdmin', isAdmin.toString())

          // 检查是否需要管理员权限
          if ((to.path === '/' || to.path === '/settings' || to.path === '/statistics') && !isAdmin) {
            console.error('非管理员用户尝试访问管理页面')
            next({ path: '/auth' })
            return
          }

          next()
        } else {
          verifyCache.clear()
          localStorage.removeItem('apiKey')
          localStorage.removeItem('isAdmin')
          next({ path: '/auth' })
        }
      } catch (error) {
        verifyCache.clear()
        localStorage.removeItem('apiKey')
        localStorage.removeItem('isAdmin')
        next({ path: '/auth' })
      }
    }
  }

})


export default router