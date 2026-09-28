<template>
  <div id="app-background">
    <div class="aurora aurora-1"></div>
    <div class="aurora aurora-2"></div>
    <div class="aurora aurora-3"></div>
    <div class="aurora aurora-4"></div>
  </div>
  <router-view></router-view>
</template>

<script setup>
import { onMounted, onBeforeUnmount } from 'vue'

// 页面不可见时暂停 CSS 动画，防止 GPU 合成层持续运行动画导致 Windows 窗口无法最小化
const handleVisibility = () => {
  document.documentElement.classList.toggle('page-hidden', document.hidden)
}

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibility)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<style lang="css" scoped>
/* ===== Pure-CSS aurora background — no <video>, no popout surface =====
   Reason for replacement:
   The previous <video autoplay loop muted> with z-index:-1000 causes
   Edge/Chrome on Windows to occasionally promote the video to an
   independent GPU media surface, which appears as a stuck white popout
   window that the page cannot dismiss. This CSS-only alternative keeps
   the colorful "炫彩" feel without any DOM media element. */

#app-background {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  background: linear-gradient(135deg, #eef2ff 0%, #faf5ff 50%, #fef3f8 100%);
}

#app-background::before {
  content: '';
  position: absolute;
  inset: -20%;
  background:
    radial-gradient(at 25% 30%, rgba(99, 102, 241, 0.18) 0px, transparent 45%),
    radial-gradient(at 80% 20%, rgba(236, 72, 153, 0.16) 0px, transparent 45%),
    radial-gradient(at 50% 80%, rgba(14, 165, 233, 0.16) 0px, transparent 45%),
    radial-gradient(at 90% 75%, rgba(16, 185, 129, 0.14) 0px, transparent 45%);
  filter: blur(40px);
  animation: aurora-drift 24s ease-in-out infinite alternate;
}

.aurora {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.55;
  mix-blend-mode: screen;
  will-change: transform;
}

.aurora-1 {
  width: 520px;
  height: 520px;
  top: -120px;
  left: -80px;
  background: radial-gradient(circle, rgba(167, 139, 250, 0.85) 0%, transparent 70%);
  animation: float-1 32s ease-in-out infinite;
}

.aurora-2 {
  width: 600px;
  height: 600px;
  top: 30%;
  right: -120px;
  background: radial-gradient(circle, rgba(244, 114, 182, 0.7) 0%, transparent 70%);
  animation: float-2 38s ease-in-out infinite;
}

.aurora-3 {
  width: 480px;
  height: 480px;
  bottom: -100px;
  left: 30%;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.7) 0%, transparent 70%);
  animation: float-3 42s ease-in-out infinite;
}

.aurora-4 {
  width: 420px;
  height: 420px;
  top: 60%;
  left: 5%;
  background: radial-gradient(circle, rgba(52, 211, 153, 0.55) 0%, transparent 70%);
  animation: float-4 36s ease-in-out infinite;
}

@keyframes aurora-drift {
  0%   { transform: translate(0, 0) scale(1); }
  50%  { transform: translate(2%, -2%) scale(1.05); }
  100% { transform: translate(-2%, 1%) scale(1.02); }
}

@keyframes float-1 { 0%,100%{transform:translate(0,0) scale(1);} 33%{transform:translate(80px,60px) scale(1.1);} 66%{transform:translate(40px,100px) scale(0.95);} }
@keyframes float-2 { 0%,100%{transform:translate(0,0) scale(1);} 50%{transform:translate(-90px,50px) scale(1.08);} }
@keyframes float-3 { 0%,100%{transform:translate(0,0) scale(1);} 50%{transform:translate(60px,-80px) scale(1.05);} }
@keyframes float-4 { 0%,100%{transform:translate(0,0) scale(1);} 50%{transform:translate(100px,-60px) scale(1.1);} }

@media (prefers-reduced-motion: reduce) {
  .aurora,
  #app-background::before { animation: none; }
}
</style>

<style>
/* 页面不可见时暂停所有动画，防止 GPU 合成层阻止 Windows 窗口最小化 */
html.page-hidden *,
html.page-hidden *::before,
html.page-hidden *::after {
  animation-play-state: paused !important;
  transition-duration: 0s !important;
}
</style>
