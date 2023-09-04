import { $wrapNodeInElement } from '@lexical/utils'
import {
  $createParagraphNode,
  $createRangeSelection,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRootOrShadowRoot,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  LexicalCommand,
  LexicalEditor,
  PASTE_COMMAND,
  createCommand
} from 'lexical'
import { realmPlugin, system } from '../../gurx'
import { coreSystem } from '../core'
import { $createImageNode, $isImageNode, CreateImageNodeOptions, ImageNode } from './ImageNode'
import { LexicalImageVisitor } from './LexicalImageVisitor'
import { MdastHtmlImageVisitor, MdastImageVisitor, MdastJsxImageVisitor } from './MdastImageVisitor'
import { CAN_USE_DOM } from '../../utils/detectMac'

export * from './ImageNode'

export type ImageUploadHandler = ((image: File) => Promise<string>) | null
export type ImagePreviewHandler = ((imageSource: string) => Promise<string>) | null

/** @internal */
export const imageSystem = system(
  (r, [{ rootEditor }]) => {
    const insertImage = r.node<string>()
    const imageAutocompleteSuggestions = r.node<string[]>([])
    const disableImageResize = r.node<boolean>(false)
    const imageUploadHandler = r.node<ImageUploadHandler>(null)
    const imagePreviewHandler = r.node<ImagePreviewHandler>(null)

    r.sub(r.pipe(insertImage, r.o.withLatestFrom(rootEditor)), ([src, theEditor]) => {
      theEditor?.update(() => {
        const imageNode = $createImageNode({ altText: '', src, title: '' })
        $insertNodes([imageNode])
        if ($isRootOrShadowRoot(imageNode.getParentOrThrow())) {
          $wrapNodeInElement(imageNode, $createParagraphNode).selectEnd()
        }
      })
    })

    r.sub(rootEditor, (editor) => {
      editor?.registerCommand<InsertImagePayload>(
        INSERT_IMAGE_COMMAND,
        (payload) => {
          const imageNode = $createImageNode(payload)
          $insertNodes([imageNode])
          if ($isRootOrShadowRoot(imageNode.getParentOrThrow())) {
            $wrapNodeInElement(imageNode, $createParagraphNode).selectEnd()
          }

          return true
        },
        COMMAND_PRIORITY_EDITOR
      )

      const theUploadHandler = r.getValue(imageUploadHandler)

      editor?.registerCommand<DragEvent>(
        DRAGSTART_COMMAND,
        (event) => {
          return onDragStart(event)
        },
        COMMAND_PRIORITY_HIGH
      )
      editor?.registerCommand<DragEvent>(
        DRAGOVER_COMMAND,
        (event) => {
          return onDragover(event)
        },
        COMMAND_PRIORITY_LOW
      )

      editor?.registerCommand<DragEvent>(
        DROP_COMMAND,
        (event) => {
          return onDrop(event, editor, r.getValue(imageUploadHandler))
        },
        COMMAND_PRIORITY_HIGH
      )

      if (theUploadHandler === null) {
        return
      }

      editor?.registerCommand(
        PASTE_COMMAND,
        (event: ClipboardEvent) => {
          let cbPayload = Array.from(event.clipboardData?.items || [])
          cbPayload = cbPayload.filter((i) => /image/.test(i.type)) // Strip out the non-image bits

          if (!cbPayload.length || cbPayload.length === 0) {
            return false
          } // If no image was present in the collection, bail.

          const imageUploadHandlerValue = r.getValue(imageUploadHandler)!

          Promise.all(cbPayload.map((file) => imageUploadHandlerValue(file.getAsFile()!)))
            .then((urls) => {
              urls.forEach((url) => {
                r.pub(insertImage, url)
              })
            })
            .catch((e) => {
              throw e
            })
          return true
        },
        COMMAND_PRIORITY_CRITICAL
      )
    })

    return {
      imageUploadHandler,
      imageAutocompleteSuggestions,
      disableImageResize,
      insertImage,
      imagePreviewHandler
    }
  },
  [coreSystem]
)

interface ImagePluginParams {
  imageUploadHandler?: ImageUploadHandler
  imageAutocompleteSuggestions?: string[]
  disableImageResize?: boolean
  imagePreviewHandler?: ImagePreviewHandler
}

export const [
  /** @internal */
  imagePlugin,
  /** @internal */
  imagePluginHooks
] = realmPlugin({
  id: 'image',
  systemSpec: imageSystem,

  applyParamsToSystem: (realm, params: ImagePluginParams) => {
    realm.pubKey('imageUploadHandler', params?.imageUploadHandler || null)
    realm.pubKey('imageAutocompleteSuggestions', params?.imageAutocompleteSuggestions || [])
    realm.pubKey('disableImageResize', Boolean(params?.disableImageResize))
    realm.pubKey('imagePreviewHandler', params?.imagePreviewHandler || null)
  },

  init: (realm) => {
    realm.pubKey('addImportVisitor', MdastImageVisitor)
    realm.pubKey('addImportVisitor', MdastHtmlImageVisitor)
    realm.pubKey('addImportVisitor', MdastJsxImageVisitor)
    realm.pubKey('addLexicalNode', ImageNode)
    realm.pubKey('addExportVisitor', LexicalImageVisitor)
  }
})

/** @internal */
export type InsertImagePayload = Readonly<CreateImageNodeOptions>

const getDOMSelection = (targetWindow: Window | null): Selection | null => (CAN_USE_DOM ? (targetWindow || window).getSelection() : null)

/**
 * @internal
 */
export const INSERT_IMAGE_COMMAND: LexicalCommand<InsertImagePayload> = createCommand('INSERT_IMAGE_COMMAND')

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function onDragStart(event: DragEvent): boolean {
  const node = getImageNodeInSelection()
  if (!node) {
    return false
  }
  const dataTransfer = event.dataTransfer
  if (!dataTransfer) {
    return false
  }
  dataTransfer.setData('text/plain', '_')
  const img = document.createElement('img')
  img.src = TRANSPARENT_IMAGE
  dataTransfer.setDragImage(img, 0, 0)
  dataTransfer.setData(
    'application/x-lexical-drag',
    JSON.stringify({
      data: {
        altText: node.__altText,
        title: node.__title,
        key: node.getKey(),
        src: node.__src
      },
      type: 'image'
    })
  )

  return true
}

function onDragover(event: DragEvent): boolean {
  // test if the user is dragging a file from the explorer
  let cbPayload = Array.from(event.dataTransfer?.items || [])
  cbPayload = cbPayload.filter((i) => /image/.test(i.type)) // Strip out the non-image bits

  if (cbPayload.length > 0) {
    event.preventDefault()
    return true
  }

  // handle moving images
  const node = getImageNodeInSelection()
  if (!node) {
    return false
  }
  if (!canDropImage(event)) {
    event.preventDefault()
  }

  return true
}

function onDrop(event: DragEvent, editor: LexicalEditor, imageUploadHandler: ImageUploadHandler): boolean {
  let cbPayload = Array.from(event.dataTransfer?.items || [])
  cbPayload = cbPayload.filter((i) => /image/.test(i.type)) // Strip out the non-image bits

  if (cbPayload.length > 0) {
    if (imageUploadHandler !== null) {
      event.preventDefault()
      Promise.all(cbPayload.map((image) => imageUploadHandler(image.getAsFile()!)))
        .then((urls) => {
          urls.forEach((url) => {
            editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
              src: url,
              altText: ''
            })
          })
        })
        .catch((e) => {
          throw e
        })

      return true
    }
  }

  const node = getImageNodeInSelection()
  if (!node) {
    return false
  }
  const data = getDragImageData(event)

  if (!data) {
    return false
  }

  event.preventDefault()
  if (canDropImage(event)) {
    const range = getDragSelection(event)
    node.remove()
    const rangeSelection = $createRangeSelection()
    if (range !== null && range !== undefined) {
      rangeSelection.applyDOMRange(range)
    }
    $setSelection(rangeSelection)
    editor.dispatchCommand(INSERT_IMAGE_COMMAND, data)
  }
  return true
}

function getImageNodeInSelection(): ImageNode | null {
  const selection = $getSelection()
  if (!$isNodeSelection(selection)) {
    return null
  }
  const nodes = selection.getNodes()
  const node = nodes[0]
  return $isImageNode(node) ? node : null
}

function getDragImageData(event: DragEvent): null | InsertImagePayload {
  const dragData = event.dataTransfer?.getData('application/x-lexical-drag')
  if (!dragData) {
    return null
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { type, data } = JSON.parse(dragData)
  if (type !== 'image') {
    return null
  }

  return data
}

declare global {
  interface DragEvent {
    rangeOffset?: number
    rangeParent?: Node
  }
}

function canDropImage(event: DragEvent): boolean {
  const target = event.target
  return !!(target && target instanceof HTMLElement && target.parentElement)
}

function getDragSelection(event: DragEvent): Range | null | undefined {
  let range
  const target = event.target as null | Element | Document
  const targetWindow =
    target == null ? null : target.nodeType === 9 ? (target as Document).defaultView : (target as Element).ownerDocument.defaultView
  const domSelection = getDOMSelection(targetWindow)
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(event.clientX, event.clientY)
  } else if (event.rangeParent && domSelection !== null) {
    domSelection.collapse(event.rangeParent, event.rangeOffset || 0)
    range = domSelection.getRangeAt(0)
  } else {
    throw Error(`Cannot get the selection when dragging`)
  }

  return range
}
