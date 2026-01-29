/**
 * Blockly 에디터 컴포넌트
 *
 * Blockly 워크스페이스 통합 및 락 메커니즘 연결
 */

import { useEffect, useRef } from 'react'
import * as Blockly from 'blockly'
import './BlocklyEditor.css'
import { LockManager } from '../services/lockManager'

interface BlocklyEditorProps {
  lockManager: LockManager
  userMap: Record<string, { nickname: string; color: string }>
  myClientId: string | null
  onCommitApply?: (blockId: string, events: any[], by: string) => void
}

function BlocklyEditor({ lockManager, userMap, myClientId, onCommitApply }: BlocklyEditorProps) {
  const blocklyDivRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null)
  const isDraggingRef = useRef<string | null>(null)  // 현재 드래그 중인 블록 ID
  const dragStartEventsRef = useRef<any[]>([])  // 드래그 시작 시 이벤트 기록
  const dragDeniedRef = useRef<string | null>(null)
  const selectedBlockIdRef = useRef<string | null>(null)
  const dragEndTimerRef = useRef<number | null>(null)
  const ownerNameCacheRef = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!blocklyDivRef.current) return

    // Blockly 워크스페이스 초기화
    const workspace = Blockly.inject(blocklyDivRef.current, {
      toolbox: getToolbox(),
      grid: {
        spacing: 20,
        length: 3,
        colour: '#ccc',
        snap: true
      },
      zoom: {
        controls: true,
        wheel: true,
        startScale: 1.0,
        maxScale: 3,
        minScale: 0.3,
        scaleSpeed: 1.2
      },
      trashcan: true,
    })

    workspaceRef.current = workspace

    // Blockly 이벤트 리스너
    workspace.addChangeListener(handleBlocklyEvent)

    const onMouseUp = () => {
      finalizeDrag('pointer')
    }
    const onTouchEnd = () => {
      finalizeDrag('touch')
    }
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('touchend', onTouchEnd, true)

    // Cleanup
    return () => {
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('touchend', onTouchEnd, true)
      workspace.dispose()
      workspaceRef.current = null
    }
  }, [])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    applyLockStateToWorkspace(workspace)
  }, [userMap])

  // LockManager 콜백 등록
  useEffect(() => {
    lockManager.onLockUpdate = (blockId, owner) => {
      handleLockUpdate(blockId, owner)
    }

    lockManager.onLockDenied = (blockId, owner, ttlMs) => {
      handleLockDenied(blockId, owner, ttlMs)
    }
  }, [lockManager, userMap, myClientId])

  /**
   * Blockly 이벤트 처리
   */
  async function handleBlocklyEvent(event: Blockly.Events.Abstract) {
    console.log('[Blockly] Event:', event.type, event)

    // BLOCK_DRAG은 UI 이벤트지만 드래그 시작/종료 판단에 필요
    if (event.type === (Blockly.Events as any).BLOCK_DRAG || event.type === 'drag') {
      await handleBlockDrag(event as any)
      return
    }

    // SELECTED는 UI 이벤트지만 락 해제 판단에 필요
    if (event.type === (Blockly.Events as any).SELECTED || event.type === 'selected') {
      await handleBlockSelected(event as any)
      return
    }

    // 클릭으로 선택 해제된 경우 락 정리
    if (event.type === (Blockly.Events as any).CLICK || event.type === 'click') {
      handleWorkspaceClick(event as any)
      return
    }

    // UI 이벤트는 무시
    if ((event as any).isUiEvent) {
      return
    }

    // BLOCK_MOVE 이벤트 처리 (드래그 중 이동/결착 포함)
    if (event.type === Blockly.Events.BLOCK_MOVE) {
      const moveEvent = event as Blockly.Events.BlockMove
      await handleBlockMove(moveEvent)
    } else {
      // BLOCK_CREATE / BLOCK_DELETE / BLOCK_CHANGE 등 즉시 커밋
      const blockId = (event as any).blockId as string | undefined
      const workspace = workspaceRef.current
      if (!blockId || !workspace) return

      // 다른 사용자가 락 잡은 블록이면 되돌림
      if (lockManager.isLocked(blockId) && !lockManager.isMyLock(blockId)) {
        console.warn(`[Blockly] Block ${blockId} is locked by another user`)
        workspace.undo(false)
        return
      }

      const eventJson = event.toJson()
      const workspaceXml = getWorkspaceSnapshot(workspace)
      lockManager.commitWithoutLock(blockId, [eventJson], workspaceXml)
    }
  }

  async function handleBlockDrag(event: any) {
    const blockId = event.blockId as string | undefined
    if (!blockId) return

    if (event.isStart) {
      if (!lockManager.isMyLock(blockId)) {
        console.log(`[Blockly] Drag blocked (no lock) for ${blockId}`)
        dragDeniedRef.current = blockId
        return
      }

      isDraggingRef.current = blockId
      dragStartEventsRef.current = []
      dragDeniedRef.current = null

      console.log(`[Blockly] Drag start: ${blockId}`)
      return
    }

    if (event.isEnd) {
      finalizeDrag('event')
      return
    }
  }

  async function handleBlockMove(moveEvent: Blockly.Events.BlockMove) {
    const blockId = moveEvent.blockId as string | undefined
    if (!blockId) return

    if (dragDeniedRef.current === blockId) {
      return
    }

    if (isDraggingRef.current === blockId) {
      dragStartEventsRef.current.push(moveEvent.toJson())
      if (dragEndTimerRef.current) {
        clearTimeout(dragEndTimerRef.current)
      }
      dragEndTimerRef.current = window.setTimeout(() => {
        finalizeDrag('debounce')
      }, 150)
      return
    }

    const workspace = workspaceRef.current
    if (!workspace) return

    const workspaceXml = getWorkspaceSnapshot(workspace)
    lockManager.commitWithoutLock(blockId, [moveEvent.toJson()], workspaceXml)
  }

  function finalizeDrag(source: 'event' | 'pointer' | 'touch' | 'debounce') {
    const blockId = isDraggingRef.current
    if (!blockId) return
    if (dragDeniedRef.current === blockId) {
      dragDeniedRef.current = null
      isDraggingRef.current = null
      dragStartEventsRef.current = []
      if (dragEndTimerRef.current) {
        clearTimeout(dragEndTimerRef.current)
        dragEndTimerRef.current = null
      }
      return
    }

    const workspace = workspaceRef.current
    const workspaceXml = workspace ? getWorkspaceSnapshot(workspace) : undefined
    const events = dragStartEventsRef.current
    console.log(`[Blockly] Drag end (${source}): ${blockId}, events:`, events)
    lockManager.commitWithoutLock(blockId, events, workspaceXml)
    isDraggingRef.current = null
    dragStartEventsRef.current = []
    if (dragEndTimerRef.current) {
      clearTimeout(dragEndTimerRef.current)
      dragEndTimerRef.current = null
    }
  }

  async function handleBlockSelected(event: any) {
    const oldId = event.oldElementId as string | undefined
    const newId = event.newElementId as string | undefined

    console.log('[Blockly] Selected change:', { oldId, newId })

    if (!oldId || oldId === newId) {
      selectedBlockIdRef.current = newId || null
      if (newId && !lockManager.isMyLock(newId)) {
        const success = await lockManager.requestLock(newId)
        if (!success) {
          console.log(`[Blockly] Lock denied for ${newId}, canceling selection`)
        }
      }
      return
    }

    if (isDraggingRef.current === oldId && !newId) {
      const workspace = workspaceRef.current
      const workspaceXml = workspace ? getWorkspaceSnapshot(workspace) : undefined
      const events = dragStartEventsRef.current
      console.warn('[Blockly] Drag end fallback via selected change')
      lockManager.releaseLock(oldId, events, workspaceXml, true)
      isDraggingRef.current = null
      dragStartEventsRef.current = []
      selectedBlockIdRef.current = null
      return
    }

    if (!lockManager.isMyLock(oldId)) {
      selectedBlockIdRef.current = newId || null
    }

    const workspace = workspaceRef.current
    if (!workspace || !workspace.getBlockById(oldId)) {
      return
    }

    const workspaceXml = getWorkspaceSnapshot(workspace)
    lockManager.releaseLock(oldId, [], workspaceXml, true)
    selectedBlockIdRef.current = newId || null
    if (newId && !lockManager.isMyLock(newId)) {
      const success = await lockManager.requestLock(newId)
      if (!success) {
        console.log(`[Blockly] Lock denied for ${newId}, canceling selection`)
      }
    }
  }

  function handleWorkspaceClick(_event: any) {
    const workspace = workspaceRef.current
    if (!workspace) return

    const selectedGetter = (Blockly as any).getSelected
    const selected = selectedGetter ? selectedGetter() : (Blockly as any).selected
    if (selected) {
      selectedBlockIdRef.current = selected.id || null
      return
    }

    if (isDraggingRef.current) {
      return
    }

    const myLocks = lockManager.getMyLocks()
    if (!myLocks.length) {
      selectedBlockIdRef.current = null
      return
    }

    const workspaceXml = getWorkspaceSnapshot(workspace)
    myLocks.forEach(lockId => {
      lockManager.releaseLock(lockId, [], workspaceXml, true)
    })
    selectedBlockIdRef.current = null
  }

  /**
   * LOCK_UPDATE 처리
   */
  function handleLockUpdate(blockId: string, owner: string | null) {
    console.log(`Lock update: ${blockId} → ${owner}`)

    const workspace = workspaceRef.current
    if (!workspace) return

    const block = workspace.getBlockById(blockId)
    if (!block) return

    if (owner) {
      // 락 획득 - 블록 강조
      const isMyLock = lockManager.isMyLock(blockId)
      applyLockToSubtree(block, owner, isMyLock, blockId)
    } else {
      // 락 해제 - 강조 제거
      clearLockFromSubtree(block)
    }
  }

  /**
   * LOCK_DENIED 처리
   */
  function handleLockDenied(blockId: string, owner: string, ttlMs: number) {
    console.log(`Lock denied for ${blockId} (owner: ${owner}, ttl: ${ttlMs}ms)`)

    // 사용자에게 알림
    alert(`다른 사용자가 이 블록을 편집 중입니다 (${Math.ceil(ttlMs / 1000)}초 후 만료)`)
  }

  /**
   * 원격 변경 적용 (COMMIT_APPLY 수신 시)
   */
  function applyRemoteChange(events: any[]) {
    const workspace = workspaceRef.current
    if (!workspace) {
      console.warn('[Blockly] Cannot apply remote change: workspace not ready')
      return
    }

    console.log('[Blockly] Applying remote changes:', events)

    // Blockly 이벤트 리스너 일시 중지 (무한 루프 방지)
    Blockly.Events.disable()

    try {
      events.forEach(eventJson => {
        console.log('[Blockly] Processing event:', eventJson)
        const event = Blockly.Events.fromJson(eventJson, workspace)
        if (event) {
          event.run(true)  // forward = true
        }
      })
      console.log('[Blockly] Remote changes applied successfully')
    } catch (error) {
      console.error('[Blockly] Error applying remote changes:', error)
    } finally {
      // 이벤트 리스너 재활성화
      Blockly.Events.enable()
    }
  }

  /**
   * 워크스페이스 스냅샷 생성 (XML)
   */
  function getWorkspaceSnapshot(workspace: Blockly.WorkspaceSvg): string {
    const xml = Blockly.Xml.workspaceToDom(workspace)
    return domToText(xml)
  }

  /**
   * 워크스페이스 스냅샷 로드 (XML)
   */
  function loadWorkspaceSnapshot(workspaceXml: string) {
    const workspace = workspaceRef.current
    if (!workspace || !workspaceXml) {
      return
    }

    Blockly.Events.disable()
    try {
      workspace.clear()
      const xml = textToDom(workspaceXml)
      Blockly.Xml.domToWorkspace(xml, workspace)
      applyLockStateToWorkspace(workspace)
      console.log('[Blockly] Workspace snapshot loaded')
    } catch (error) {
      console.error('[Blockly] Failed to load workspace snapshot:', error)
    } finally {
      Blockly.Events.enable()
    }
  }

  function applyLockStateToWorkspace(workspace: Blockly.WorkspaceSvg) {
    const locks = lockManager.getAllLocks()
    locks.forEach((owner, blockId) => {
      const block = workspace.getBlockById(blockId)
      if (!block) return
      const isMyLock = lockManager.isMyLock(blockId)
      applyLockToSubtree(block, owner, isMyLock, blockId)
    })
  }

  function setBlockInteractivity(block: Blockly.Block, enabled: boolean) {
    block.setEditable(enabled)
    block.setMovable(enabled)
    block.setDeletable(enabled)
    const selectableFn = (block as any).setSelectable
    if (selectableFn) {
      selectableFn.call(block, enabled)
    }
  }

  function getConnectedGroupBlocks(block: Blockly.Block): Blockly.Block[] {
    const root = block.getRootBlock()
    return root.getDescendants(true)
  }

  function applyLockToSubtree(block: Blockly.Block, owner: string, isMyLock: boolean, lockedBlockId: string) {
    const groupBlocks = getConnectedGroupBlocks(block)
    groupBlocks.forEach(subBlock => {
      highlightBlock(subBlock, isMyLock ? 'my-lock' : 'other-lock')
      setBlockInteractivity(subBlock, isMyLock)
      if (subBlock.id === lockedBlockId) {
        if (isMyLock) {
          clearBlockLockBadge(subBlock)
        } else {
          const label = getOwnerLabel(owner)
          if (label) {
            setBlockLockBadge(subBlock, label)
          } else {
            clearBlockLockBadge(subBlock)
          }
        }
      } else {
        clearBlockLockBadge(subBlock)
      }
    })
  }

  function clearLockFromSubtree(block: Blockly.Block) {
    const groupBlocks = getConnectedGroupBlocks(block)
    groupBlocks.forEach(subBlock => {
      unhighlightBlock(subBlock)
      setBlockInteractivity(subBlock, true)
      clearBlockLockBadge(subBlock)
    })
  }

  function getOwnerLabel(owner: string): string {
    const nickname = userMap[owner]?.nickname
    if (nickname) {
      ownerNameCacheRef.current[owner] = nickname
      return `${nickname}`
    }
    const cached = ownerNameCacheRef.current[owner]
    return cached ? `${cached}` : ''
  }

  function setBlockLockBadge(block: Blockly.Block, text: string) {
    const svgRoot = block.getSvgRoot()
    if (!svgRoot) return

    const existing = svgRoot.querySelector('text.lock-badge') as SVGTextElement | null
    const badge = existing || document.createElementNS('http://www.w3.org/2000/svg', 'text')
    badge.textContent = text
    badge.setAttribute('class', 'lock-badge')
    badge.setAttribute('fill', '#000')
    badge.setAttribute('font-size', '10')
    badge.setAttribute('text-anchor', 'end')
    badge.setAttribute('dominant-baseline', 'hanging')

    const box = svgRoot.getBBox()
    badge.setAttribute('x', String(box.width - 4))
    badge.setAttribute('y', '2')

    if (!existing) {
      svgRoot.appendChild(badge)
    }
  }

  function clearBlockLockBadge(block: Blockly.Block) {
    const svgRoot = block.getSvgRoot()
    if (!svgRoot) return
    const existing = svgRoot.querySelector('text.lock-badge')
    if (existing) {
      existing.remove()
    }
  }

  function textToDom(text: string): Element {
    const legacy = (Blockly as any).Xml?.textToDom
    if (legacy) {
      return legacy(text)
    }
    return (Blockly as any).utils.xml.textToDom(text)
  }

  function domToText(dom: Element): string {
    const legacy = (Blockly as any).Xml?.domToText
    if (legacy) {
      return legacy(dom)
    }
    return (Blockly as any).utils.xml.domToText(dom)
  }

  /**
   * 블록 강조
   */
  function highlightBlock(block: Blockly.Block, className: string) {
    const svgRoot = block.getSvgRoot()
    if (svgRoot) {
      svgRoot.classList.add(className)
    }
  }

  /**
   * 블록 강조 제거
   */
  function unhighlightBlock(block: Blockly.Block) {
    const svgRoot = block.getSvgRoot()
    if (svgRoot) {
      svgRoot.classList.remove('my-lock', 'other-lock')
    }
  }

  // onCommitApply prop으로 받은 콜백 등록
  useEffect(() => {
    if (onCommitApply) {
      // 이 부분은 Workspace 컴포넌트에서 WebSocket 메시지를 받아서 호출
      // 여기서는 applyRemoteChange 함수를 외부에 노출해야 함
      // useImperativeHandle 사용 가능
    }
  }, [onCommitApply])

  // applyRemoteChange를 외부에서 호출할 수 있도록 window에 등록
  useEffect(() => {
    (window as any).__applyRemoteChange = applyRemoteChange
    ;(window as any).__loadWorkspaceSnapshot = loadWorkspaceSnapshot
    console.log('[Blockly] applyRemoteChange registered')

    // Workspace가 준비되기 전에 들어온 스냅샷 적용
    const pendingSnapshot = (window as any).__pendingWorkspaceSnapshot as string | undefined
    if (pendingSnapshot) {
      loadWorkspaceSnapshot(pendingSnapshot)
      delete (window as any).__pendingWorkspaceSnapshot
    }

    return () => {
      delete (window as any).__applyRemoteChange
      delete (window as any).__loadWorkspaceSnapshot
    }
  }, [])

  return (
    <div className="blockly-editor">
      <div ref={blocklyDivRef} className="blockly-workspace" />
    </div>
  )
}

/**
 * Blockly 툴박스 정의
 */
function getToolbox(): Blockly.utils.toolbox.ToolboxDefinition {
  return {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category',
        name: '논리',
        colour: '#5C81A6',
        contents: [
          { kind: 'block', type: 'controls_if' },
          { kind: 'block', type: 'logic_compare' },
          { kind: 'block', type: 'logic_operation' },
          { kind: 'block', type: 'logic_boolean' },
        ]
      },
      {
        kind: 'category',
        name: '반복',
        colour: '#5CA65C',
        contents: [
          { kind: 'block', type: 'controls_repeat_ext' },
          { kind: 'block', type: 'controls_whileUntil' },
        ]
      },
      {
        kind: 'category',
        name: '수학',
        colour: '#5C68A6',
        contents: [
          { kind: 'block', type: 'math_number' },
          { kind: 'block', type: 'math_arithmetic' },
        ]
      },
      {
        kind: 'category',
        name: '텍스트',
        colour: '#5CA68D',
        contents: [
          { kind: 'block', type: 'text' },
          { kind: 'block', type: 'text_print' },
        ]
      },
    ]
  }
}

export default BlocklyEditor
