/// <reference path='services.ts' />

/* @internal */
namespace ts.NavigationBar {
    export function getNavigationBarItems(sourceFile: SourceFile): NavigationBarItem[] {
        const root = createNavNode(undefined, sourceFile);
        sortChildren(root);
        return map(topLevelItems(root), convertToTopLevelItem);
    }

    /**
     * Represents a navBar item and its children.
     * The returned NavigationBarItem is more complicated and doesn't include 'parent', so we use these to do work before converting.
     */
    interface NavNode {
        node: Node,
        additionalNodes?: Node[],
        parent: NavNode, // Missing for root decl
        children: NavNode[],
        indent: number // # of parents
    }
    function navKind(n: NavNode): SyntaxKind {
        return n.node.kind;
    }
    function navModifiers(n: NavNode): string {
        return getNodeModifiers(n.node);
    }

    /** Creates a child node and adds it to parent. */
    function createNavNode(parent: NavNode, node: Node): NavNode {
        // `item` is set during `convertToItem`
        const item: NavNode = { node, parent, children: [], indent: parent ? parent.indent + 1 : 0 }
        if (parent) {
            parent.children.push(item);
        }
        addChildren(item);
        return item;
    }
    /** Traverse through parent.node's descendants and find declarations to add as parent's children. */
    function addChildren(parent: NavNode): void {
        function recur(node: Node) {
            if (isDeclaration(node)) { //TODO (later): get rid of this call, just use 1 switch statement.
                switch (node.kind) {
                    case SyntaxKind.TypeParameter:
                    case SyntaxKind.PropertyAssignment:
                        // Don't treat this as a declaration.
                        forEachChild(node, recur);
                        break;

                    case SyntaxKind.Constructor:
                        // Get parameter properties, and treat them as being on the *same* level as the constructor, not under it.
                        const ctr = <ConstructorDeclaration>node;
                        createNavNode(parent, ctr);
                        for (const param of ctr.parameters) {
                            if (isParameterPropertyDeclaration(param)) {
                                createNavNode(parent, param);
                            }
                        }
                        break;

                    case SyntaxKind.MethodDeclaration:
                    case SyntaxKind.MethodSignature:
                    case SyntaxKind.GetAccessor:
                    case SyntaxKind.SetAccessor:
                    case SyntaxKind.PropertyDeclaration:
                    case SyntaxKind.PropertySignature:
                        if (!hasDynamicName((<ClassElement | TypeElement> node))) {
                            createNavNode(parent, node);
                        }
                        break;

                    case SyntaxKind.EnumMember:
                        if (!isComputedProperty(<EnumMember>node)) {
                            createNavNode(parent, node);
                        }
                        break;

                    case SyntaxKind.ImportClause:
                        let importClause = <ImportClause>node;
                        // Handle default import case e.g.:
                        //    import d from "mod";
                        if (importClause.name) {
                            createNavNode(parent, importClause);
                        }

                        // Handle named bindings in imports e.g.:
                        //    import * as NS from "mod";
                        //    import {a, b as B} from "mod";
                        if (importClause.namedBindings) {
                            if (importClause.namedBindings.kind === SyntaxKind.NamespaceImport) {
                                createNavNode(parent, <NamespaceImport>importClause.namedBindings);
                            }
                            else {
                                forEach((<NamedImports>importClause.namedBindings).elements, recur);
                            }
                        }
                        break;

                    case SyntaxKind.BindingElement:
                    case SyntaxKind.VariableDeclaration:
                        const decl = <VariableDeclaration>node;
                        const name = decl.name;
                        if (isBindingPattern(name)) {
                            recur(name);
                        }
                        else if (decl.initializer && isFunctionOrClassExpression(decl.initializer)) {
                            // For `const x = function() {}`, just use the function node, not the const.
                            recur(decl.initializer);
                        }
                        else {
                            createNavNode(parent, node);
                        }
                        break;

                    //case SyntaxKind.FunctionDeclaration:
                        //Do nothing for 'broken' function with no body like `export function;`
                        //if ((<FunctionDeclaration>node).body) {
                        //    createNavNode(parent, node);
                        //}
                        //break;

                    default:
                        createNavNode(parent, node);
                }
            }
            else {
                switch (node.kind) {
                    case SyntaxKind.CallSignature:
                    case SyntaxKind.ConstructSignature:
                    case SyntaxKind.IndexSignature:
                    case SyntaxKind.MethodSignature:
                        createNavNode(parent, node);
                        break;
                    default:
                        forEachChild(node, recur);
                }
            }
        }

        let parentNode = parent.node;
        if (parentNode.kind === SyntaxKind.ModuleDeclaration) {
            parentNode = getInteriorModule(<ModuleDeclaration>parentNode);
        }
        forEachChild(parentNode, recur);

        parent.children = mergeChildren(parent.children);
        //TODO: sort children here
    }

    //TODO: mutate input array
    function mergeChildren(children: NavNode[]): NavNode[] {
        const map: Map<NavNode[]> = {};
        return filter(children, child => {
            const decl = <Declaration>child.node;
            const name = decl.name && decl.name.getText();
            if (!name)
                // Anonymous items are never merged.
                return true;

            const itemsWithSameName = map[name];
            if (!itemsWithSameName) {
                map[name] = [child];
                return true;
            }

            for (const s of itemsWithSameName) {
                if (shouldReallyMerge(s.node, child.node)) {
                    merge(s, child);
                    return false;
                }
            }
            itemsWithSameName.push(child);
            return true;
        });
    }

    //TODO: less verbose
    function shouldReallyMerge(a: Node, b: Node): boolean {
        if (a.kind !== b.kind) {
            return false;
        }
        const kind = a.kind;
        if (kind === SyntaxKind.ModuleDeclaration) {
            // We use 1 NavNode to represent 'A.B.C', but there are multiple source nodes.
            // Only merge module nodes that have the same chain. Don't merge 'A.B.C' with 'A'!
            return areSameModule(<ModuleDeclaration>a, <ModuleDeclaration>b);
        }
        else {
            return true;
        }
    }
    function areSameModule(a: ModuleDeclaration, b: ModuleDeclaration): boolean {
        if (a.body.kind !== b.body.kind) {
            return false;
        }
        if (a.body.kind !== SyntaxKind.ModuleDeclaration) {
            return true;
        }
        return areSameModule(<ModuleDeclaration>a.body, <ModuleDeclaration>b.body);
    }

    /** Merge source into target. Source should be thrown away after this is called. */
    function merge(target: NavNode, source: NavNode): void {
        target.additionalNodes = target.additionalNodes || [];
        target.additionalNodes.push(source.node);
        if (source.additionalNodes) {
            target.additionalNodes.push(...source.additionalNodes);
        }

        //TODO: faster methods available (target.children and source.children are each already merged!)
        target.children = mergeChildren(target.children.concat(source.children));
    }

    /** Recursively ensure that each NavNode's children are in sorted order. */
    //TODO:LATER: do this during creation step?
    function sortChildren(item: NavNode): void {
        for (const child of item.children)
            sortChildren(child);
        item.children.sort((child1, child2) => {
            const name1 = (<Declaration>child1.node).name, name2 = (<Declaration>child2.node).name;
            if (name1 && name2) {
                const cmp = localeCompareFix(getPropertyNameForPropertyNameNode(name1), getPropertyNameForPropertyNameNode(name2));
                return cmp !== 0 ? cmp : navKind(child1) - navKind(child2);
            }
            if (name1) {
                return 1;
            }
            if (name2) {
                return -1;
            }
            else {
                return navKind(child1) - navKind(child2);
            }

            // node 0.10 treats "a" as greater than "B".
            // For consistency, sort alphabetically, falling back to which is lower-case.
            function localeCompareFix(a: string, b: string): number {
                const cmp = a.toLowerCase().localeCompare(b.toLowerCase());
                if (cmp !== 0)
                    return cmp;
                // Return the *opposite* of the `<` operator, which works the same in node 0.10 and 6.0.
                return a < b ? 1 : a > b ? -1 : 0;
            }
        });
    }

    function getItemName(node: Node): string {
        if (node.kind === SyntaxKind.ModuleDeclaration) {
            return getModuleName(<ModuleDeclaration>node);
        }

        const name = (<Declaration>node).name;
        if (name) {
            const text = name.getText();
            if (text.length > 0)
                return text;
        }

        switch (node.kind) {
            case SyntaxKind.SourceFile:
                const sourceFile = <SourceFile>node;
                return isExternalModule(sourceFile)
                    ? `"${escapeString(getBaseFileName(removeFileExtension(normalizePath(sourceFile.fileName))))}"`
                    : "<global>";
            case SyntaxKind.ArrowFunction:
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.FunctionExpression:
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.ClassExpression:
                if (node.flags & NodeFlags.Default) {
                    return "default";
                }
                return getFunctionOrClassName(<ArrowFunction | FunctionExpression | ClassExpression>node);
            case SyntaxKind.Constructor:
                return "constructor";
            case SyntaxKind.ConstructSignature:
                return "new()";
            case SyntaxKind.CallSignature:
                return "()";
            case SyntaxKind.IndexSignature:
                return "[]";
            default:
                //Assume is for "export default"
                return "default";
        }
    }

    function topLevelItems(root: NavNode): NavNode[] {
        const topLevel: NavNode[] = [];
        function recur(item: NavNode) {
            if (isTopLevel(item)) {
                topLevel.push(item);
                for (const child of item.children) {
                    recur(child);
                }
            }
        }
        recur(root);
        return topLevel;
    }
    function isTopLevel(item: NavNode): boolean {
        switch (navKind(item)) {
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.ClassExpression:
            case SyntaxKind.EnumDeclaration:
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.ModuleDeclaration:
            case SyntaxKind.SourceFile:
            case SyntaxKind.TypeAliasDeclaration:
                return true;

            //Looks like these are currently never top-level?
            /*case SyntaxKind.VariableDeclaration:
            case SyntaxKind.BindingElement:
                // These are only top-level items if they appear in module scope.
                const parentKind = dumbKind(item.parent);
                return parentKind === SyntaxKind.ModuleDeclaration || parentKind === SyntaxKind.SourceFile;*/

            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.FunctionExpression:
                return isTopLevelFunctionDeclaration(item);

            default:
                return false;
        }
    }
    function isTopLevelFunctionDeclaration(item: NavNode): boolean {
        if (!(<FunctionDeclaration>item.node).body) {
            return false;
        }

        //TODO: if it has a name, it's top-level! Right?
        switch (navKind(item.parent)) {
            case SyntaxKind.ModuleBlock:
            case SyntaxKind.SourceFile:
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.Constructor:
                return true;
        }
        return item.children.some(child => {
            const childKind = navKind(child);
            switch (childKind) {
                case SyntaxKind.VariableDeclaration:
                case SyntaxKind.BindingElement:
                    return false;
                default:
                    return true;
            }
        })
    }

    function convertToTopLevelItem(dumb: NavNode): NavigationBarItem {
        const spans = [getNodeSpan(dumb.node)];
        return {
            text: getItemName(dumb.node),
            kind: realNodeKind(dumb.node),
            kindModifiers: navModifiers(dumb),
            spans,
            childItems: map(dumb.children, convertToChildItem),
            indent: dumb.indent,
            bolded: false,
            grayed: false
        }
    }
    function convertToChildItem(dumb: NavNode): NavigationBarItem {
        //TODO: if this works, it's because I'm not testing merging well enough!
        const spans = [getNodeSpan(dumb.node)];
        return {
            text: getItemName(dumb.node),
            kind: realNodeKind(dumb.node),
            kindModifiers: navModifiers(dumb),
            spans,
            childItems: [],
            indent: 0,
            bolded: false,
            grayed: false
        }
    }

    //This is here to preserve the old behavior and minimize test changes.
    //TODO: file issue, we should just use getNodeKind and behave the same as navigateTo.
    function realNodeKind(node: Node) {
        switch (node.kind) {
            case SyntaxKind.SourceFile:
                return ScriptElementKind.moduleElement;
            case SyntaxKind.EnumMember:
                return ScriptElementKind.memberVariableElement;
            case SyntaxKind.VariableDeclaration:
            case SyntaxKind.BindingElement:
                let variableDeclarationNode: Node;
                let name: Node;

                if (node.kind === SyntaxKind.BindingElement) {
                    name = (<BindingElement>node).name;
                    variableDeclarationNode = node;
                    // binding elements are added only for variable declarations
                    // bubble up to the containing variable declaration
                    while (variableDeclarationNode && variableDeclarationNode.kind !== SyntaxKind.VariableDeclaration) {
                        variableDeclarationNode = variableDeclarationNode.parent;
                    }
                    Debug.assert(variableDeclarationNode !== undefined);
                }
                else {
                    Debug.assert(!isBindingPattern((<VariableDeclaration>node).name));
                    variableDeclarationNode = node;
                    name = (<VariableDeclaration>node).name;
                }

                if (isConst(variableDeclarationNode)) {
                    return ts.ScriptElementKind.constElement;
                }
                else if (isLet(variableDeclarationNode)) {
                    return ts.ScriptElementKind.letElement;
                }
                else {
                    return ts.ScriptElementKind.variableElement;
                }
            default:
                return getNodeKind(node);
        }
    }

    function getModuleName(moduleDeclaration: ModuleDeclaration): string {
        // We want to maintain quotation marks.
        if (isAmbientModule(moduleDeclaration)) {
            return getTextOfNode(moduleDeclaration.name);
        }

        // Otherwise, we need to aggregate each identifier to build up the qualified name.
        const result: string[] = [];

        result.push(moduleDeclaration.name.text);

        while (moduleDeclaration.body && moduleDeclaration.body.kind === SyntaxKind.ModuleDeclaration) {
            moduleDeclaration = <ModuleDeclaration>moduleDeclaration.body;

            result.push(moduleDeclaration.name.text);
        }

        return result.join(".");
    }

    // For 'module A.B.C', we want to get the node for 'C'.
    // We store 'A' as associated with a DumbItem, and use getModuleName to traverse down again.
    function getInteriorModule(decl: ModuleDeclaration): ModuleDeclaration {
        return decl.body.kind === SyntaxKind.ModuleDeclaration ? getInteriorModule(<ModuleDeclaration>decl.body) : decl;
    }

    function isComputedProperty(member: EnumMember): boolean {
        return member.name === undefined || member.name.kind === SyntaxKind.ComputedPropertyName;
    }

    function getNodeSpan(node: Node) {
        return node.kind === SyntaxKind.SourceFile
            ? createTextSpanFromBounds(node.getFullStart(), node.getEnd())
            : createTextSpanFromBounds(node.getStart(), node.getEnd());
    }

    function getFunctionOrClassName(node: FunctionExpression | FunctionDeclaration | ArrowFunction | ClassLikeDeclaration): string {
        if (node.name && getFullWidth(node.name) > 0) {
            return declarationNameToString(node.name);
        }
        // See if it is a var initializer. If so, use the var name.
        else if (node.parent.kind === SyntaxKind.VariableDeclaration) {
            return declarationNameToString((node.parent as VariableDeclaration).name);
        }
        // See if it is of the form "<expr> = function(){...}". If so, use the text from the left-hand side.
        else if (node.parent.kind === SyntaxKind.BinaryExpression &&
            (node.parent as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken) {
            return (node.parent as BinaryExpression).left.getText();
        }
        // See if it is a property assignment, and if so use the property name
        else if (node.parent.kind === SyntaxKind.PropertyAssignment && (node.parent as PropertyAssignment).name) {
            return (node.parent as PropertyAssignment).name.getText();
        }
        // Default exports are named "default"
        else if (node.flags & NodeFlags.Default) {
            return "default";
        }
        else {
            return isClassLike(node) ? anonymousClassText : anonymousFunctionText;
        }
    }

    const anonymousFunctionText = "<function>";
    const anonymousClassText = "<class>";

    function isFunctionOrClassExpression(node: Node): boolean {
        return node.kind === SyntaxKind.FunctionExpression || node.kind === SyntaxKind.ArrowFunction || node.kind === SyntaxKind.ClassExpression;
    }
}
