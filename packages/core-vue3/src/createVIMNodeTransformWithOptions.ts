import mime from "mime";

import {
  IMAGE_FORMATS,
  VIMOptions,
  defaultVIMOptions,
  getMIMEFromImageFormat,
  parseElementLevelOptions,
} from "@vue-image-modernizer/core-shared";
import {
  AttributeNode,
  ConstantTypes,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTransform,
  NodeTypes,
  SourceLocation,
  TransformContext,
  createSimpleExpression,
  transformElement,
} from "@vue/compiler-core";

export function createVIMNodeTransformWithOptions(
  options: VIMOptions
): NodeTransform {
  return function modernizeImgs(node, context) {
    // eslint-disable-next-line @typescript-eslint/ban-types
    return (vimNodeTransform as Function)(node, context, options);
  };
}

/**
 * A `@vue/compiler-core` plugin that transforms <img> into <picture> or
 * whatever is specified
 *
 * ``` js
 * // Before
 * createVNode("img", { src: "./logo.png", modernize: ""})
 *
 * // After
 * import _imports_0 from '-!webpack-image-srcset-loader?{"sizes":["480w","1024w","1920w","2560w","original"]}!webpack-image-resize-loader?{"format":"webp","quality":80}!./logo.png'
 * import _imports_1 from '-!webpack-image-srcset-loader?{"sizes":["480w","1024w","1920w","2560w","original"]}!webpack-image-resize-loader?{"quality":80}!./logo.png'
 * import _imports_2 from '-!webpack-image-resize-loader?{"format":"jpeg","quality":80}!./logo.png'
 *
 * createVNode("picture", null, [
 *    createVNode("source", { type: "image/webp", src: _imports_0})
 *    createVNode("source", { type: "image/jpeg", src: _imports_1})
 *    createVNode("img", { src: _imports_2})
 * ])
 * ```
 */
export const vimNodeTransform: NodeTransform = (
  node,
  context,
  options: VIMOptions = defaultVIMOptions
) => {
  if (node.type !== NodeTypes.ELEMENT) return;
  if (node.props.length === 0) return;
  if (node.tag.toLowerCase() !== "img") return;

  options = { ...defaultVIMOptions, ...options };

  const directiveAttribute = node.props.find(
    (attr) =>
      attr.type === NodeTypes.ATTRIBUTE && attr.name === options.attributeName
  ) as AttributeNode;

  if (directiveAttribute === undefined) return;

  const elementLevelOptions = directiveAttribute.value
    ? parseElementLevelOptions(directiveAttribute.value.content)
    : {};

  const combinedOptions = {
    ...options,
    ...elementLevelOptions,
    quality: {
      ...options.quality,
      ...elementLevelOptions.quality,
    },
  } as Required<VIMOptions>;

  // src bind directive is created by transformAssetUrl
  const srcBindDirectiveIndex = node.props.findIndex(isPropSrcBindDirective);
  if (srcBindDirectiveIndex !== -1) {
    const srcBindDirective = node.props[srcBindDirectiveIndex] as DirectiveNode;

    const exp = srcBindDirective.exp;
    const importsArray = Array.from(context.imports);
    const srcImport = importsArray.find((i) => i.exp === exp);

    if (srcImport === undefined)
      throw new Error("src attribute does not have a value");

    const srcFilePath = srcImport.path;

    // srcImport.exp and srcBindDirective.exp are the same when
    // the current node is the first in the tree to import from that path
    // so it's safe to remove it
    if (srcImport.exp === srcBindDirective.exp)
      context.imports.delete(srcImport);

    return transformImgWithSrc({
      node,
      srcFilePath,
      srcPropIndex: srcBindDirectiveIndex,
      srcProp: srcBindDirective,
      directiveAttribute,
      options: combinedOptions,
      context,
    });
  }

  // src attribute only exist if transformAssetUrl
  // has not already transformed it,
  // unlikely to happen since most users will be using
  // the default options for @vue/compiler-sfc
  const srcAttributeIndex = node.props.findIndex(isPropSrcAttribute);

  if (srcAttributeIndex !== -1) {
    const srcAttribute = node.props[srcAttributeIndex] as AttributeNode;
    const srcFilePath = srcAttribute.value?.content;

    if (srcFilePath === undefined)
      throw new Error("src attribute does not have a value");

    return transformImgWithSrc({
      node,
      srcFilePath,
      srcPropIndex: srcAttributeIndex,
      srcProp: srcAttribute,
      directiveAttribute,
      options: combinedOptions,
      context,
    });
  }

  throw new Error("src attribute not found");
};

function transformImgWithSrc(transformOptions: {
  node: ElementNode;
  srcFilePath: string;
  srcPropIndex: number;
  srcProp: AttributeNode | DirectiveNode;
  directiveAttribute: AttributeNode;
  options: Required<VIMOptions>;
  context: TransformContext;
}): void | (() => void) {
  const {
    node,
    srcFilePath,
    srcPropIndex,
    srcProp,
    directiveAttribute,
    options,
    context,
  } = transformOptions;

  // only need to change props of img tag if these options are true
  if (options.compressOnly || options.onlyUseImg) {
    const compressedSrcExp = getImportsExpressionExp(
      options.compressFilePathTransformer(srcFilePath, options),
      srcProp.loc,
      context
    );

    node.props[srcPropIndex] = createSrcDirectiveNode(
      compressedSrcExp,
      srcProp.loc
    );

    if (!options.compressOnly && options.onlyUseImg) {
      const srcSetExp = getImportsExpressionExp(
        options.srcSetFilePathTransformer(srcFilePath, options),
        srcProp.loc,
        context
      );

      node.props.push(createSrcSetDirectiveNode(srcSetExp, srcProp.loc));
    }

    if (!options.noLazy) {
      addLoadingAttribute(node, directiveAttribute.loc);
    }

    // remove directiveAttribute
    node.props = node.props.filter((prop) => prop !== directiveAttribute);

    return;
  }

  return transformElementIntoPicture(transformOptions);
}

function transformElementIntoPicture(transformOptions: {
  node: ElementNode;
  srcFilePath: string;
  srcProp: AttributeNode | DirectiveNode;
  directiveAttribute: AttributeNode;
  options: Required<VIMOptions>;
  context: TransformContext;
}): void | (() => void) {
  const {
    node,
    srcFilePath,
    srcProp,
    directiveAttribute,
    options,
    context,
  } = transformOptions;

  const currentImgNodeClone: ElementNode = {
    ...node,
    props: node.props.filter((attribute) => attribute !== directiveAttribute),
  };

  if (!options.noLazy) {
    addLoadingAttribute(currentImgNodeClone, directiveAttribute.loc);
  }

  const pictureNode: ElementNode = {
    type: NodeTypes.ELEMENT,
    ns: node.ns,
    tag: "picture",
    tagType: ElementTypes.ELEMENT,
    props: [],
    isSelfClosing: false,
    children: [],
    loc: node.loc,
    codegenNode: undefined,
  };

  pictureNode.children.push(currentImgNodeClone);

  context.replaceNode(pictureNode);

  return () => {
    if (context.currentNode !== pictureNode) return;

    const sourceNodes: ElementNode[] = [];

    // add source elements
    options.imageFormats.forEach((format) => {
      const mimeType =
        format === "original"
          ? (mime.getType(srcFilePath) as keyof typeof IMAGE_FORMATS)
          : getMIMEFromImageFormat(format);

      // skip if there is already a source with the same type
      if (
        sourceNodes.some(
          (node) =>
            node.props[0].type === NodeTypes.ATTRIBUTE &&
            node.props[0].name === "type" &&
            node.props[0].value?.content === mimeType
        )
      )
        return;

      const srcSetExp = getImportsExpressionExp(
        options.srcSetFilePathTransformer(srcFilePath, options, mimeType),
        srcProp.loc,
        context
      );

      const sourceNode: ElementNode = {
        type: NodeTypes.ELEMENT,
        ns: node.ns,
        tag: "source",
        tagType: ElementTypes.ELEMENT,
        props: [
          {
            type: NodeTypes.ATTRIBUTE,
            name: "type",
            value: {
              type: 2,
              content: mimeType,
              loc: directiveAttribute.loc,
            },
            loc: directiveAttribute.loc,
          },
          createSrcSetDirectiveNode(srcSetExp, srcProp.loc),
        ],
        isSelfClosing: true,
        children: [],
        loc: node.loc,
        codegenNode: undefined,
      };

      sourceNodes.push(sourceNode);
    });

    // put the source elements before the img element
    pictureNode.children = [...sourceNodes, ...pictureNode.children];

    const compressedSrcExp = getImportsExpressionExp(
      options.compressFilePathTransformer(srcFilePath, options),
      srcProp.loc,
      context
    );

    const srcAttributeIndex = currentImgNodeClone.props.findIndex(
      (attr) =>
        // if this transform comes before transformAssetUrl
        isPropSrcAttribute(attr) ||
        // if this transform comes after transformAssetUrl, src will already be transformed into a directive
        isPropSrcBindDirective(attr)
    );

    if (srcAttributeIndex === -1) throw new Error("src attribute not found");

    // replace the src node with new directive node that has the compressed image
    currentImgNodeClone.props[srcAttributeIndex] = createSrcDirectiveNode(
      compressedSrcExp,
      srcProp.loc
    );

    // TODO: remove when https://github.com/vuejs/vue-next/pull/2927 is merged
    (transformElement(pictureNode, context) as () => void)();
    pictureNode.children.forEach((node) => {
      if (node.type !== NodeTypes.ELEMENT) return;
      node.codegenNode = undefined;
      (transformElement(node, context) as () => void)();
    });
  };
}

function addLoadingAttribute(
  node: ElementNode,
  sourceLoc: SourceLocation
): void {
  // skip if loading attribute exist
  if (node.props.some(({ name }) => name === "loading")) return;

  node.props.push(createLoadingAttributeNode(sourceLoc));
}

function createSrcDirectiveNode(
  srcExp: ExpressionNode,
  sourceLoc: SourceLocation
): DirectiveNode {
  return {
    type: NodeTypes.DIRECTIVE,
    name: "bind",
    arg: createSimpleExpression("src", true, sourceLoc),
    exp: srcExp,
    modifiers: [],
    loc: sourceLoc,
  };
}

function createSrcSetDirectiveNode(
  srcSetExp: ExpressionNode,
  sourceLoc: SourceLocation
): DirectiveNode {
  return {
    type: NodeTypes.DIRECTIVE,
    name: "bind",
    arg: createSimpleExpression("srcset", true, sourceLoc),
    exp: srcSetExp,
    modifiers: [],
    loc: sourceLoc,
  };
}

function createLoadingAttributeNode(sourceLoc: SourceLocation): AttributeNode {
  return {
    type: NodeTypes.ATTRIBUTE,
    name: "loading",
    loc: sourceLoc,
    value: {
      type: NodeTypes.TEXT,
      content: "lazy",
      loc: sourceLoc,
    },
  };
}

function isPropSrcBindDirective(prop: AttributeNode | DirectiveNode): boolean {
  return (
    prop.type === NodeTypes.DIRECTIVE &&
    prop.name === "bind" &&
    prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
    prop.arg.content === "src"
  );
}

function isPropSrcAttribute(prop: AttributeNode | DirectiveNode): boolean {
  return prop.type === NodeTypes.ATTRIBUTE && prop.name === "src";
}

/**
 * return an import expression and add import path
 * to imports list in context
 *
 * copied from https://github.com/vuejs/vue-next/blob/db786b1afe41c26611a215e6d6599d50312b9c2f/packages/compiler-sfc/src/templateTransformAssetUrl.ts#L155
 */
function getImportsExpressionExp(
  path: string,
  loc: SourceLocation,
  context: TransformContext
): ExpressionNode {
  const importsArray = Array.from(context.imports);
  const existing = importsArray.find((i) => i.path === path);
  if (existing) {
    return existing.exp as ExpressionNode;
  }
  const name = `_imports_${importsArray.length}`;
  const exp = createSimpleExpression(name, false, loc, ConstantTypes.CAN_HOIST);
  context.imports.add({ exp, path });

  return exp;
}
