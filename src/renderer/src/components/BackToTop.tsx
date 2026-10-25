import { useEffect, useState } from 'react'

// 滚动超过一屏（.main 的可视高度）后显示，阈值随窗口大小动态变化
export default function BackToTop() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.main')
    if (!main) return
    const update = (): void => setVisible(main.scrollTop > main.clientHeight)
    update()
    main.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      main.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  // 停靠层位于 .main 内部且 sticky 于滚动区域底边，因此始终位于状态栏上方
  return (
    <div className="back-to-top-dock">
      <button
        type="button"
        className={`back-to-top${visible ? ' visible' : ''}`}
        title="返回顶部"
        aria-label="返回顶部"
        aria-hidden={!visible}
        tabIndex={visible ? 0 : -1}
        onClick={() => document.querySelector<HTMLElement>('.main')?.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        ↑
      </button>
    </div>
  )
}
