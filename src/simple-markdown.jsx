/** @jsx React.DOM */
var _ = require("underscore");

/**
 * Creates a parser for a given set of rules, with the precedence
 * specified as a list of rules.
 *
 * @rules: an object containing rule type -> {regex, parse} objects
 * @ruleList: an array of rule types, specifying the precedence rules
 *   are evaluated in (earlier in the array is higher precendence)
 *
 * @returns The resulting parse function, with the following parameters:
 *   @source: the input source string to be parsed
 *   @state: an optional object to be threaded through parse
 *     calls. Allows clients to add stateful operations to
 *     parsing, such as keeping track of how many levels deep
 *     some nesting is. For an example use-case, see passage-ref
 *     parsing in src/widgets/passage/passage-markdown.jsx
 *
 * Regexes adapted from marked.js:
 * https://github.com/chjj/marked
 */
var parserFor = (rules, ruleList) => {
    var nestedParse = (source, state) => {
        var result = [];
        state = state || {};
        while (source) {
            var i = 0;
            while (i < ruleList.length) {
                var ruleType = ruleList[i];
                var rule = rules[ruleType];
                var capture = rule.regex.exec(source);
                if (capture) {
                    source = source.substring(capture[0].length);
                    var parsed = _.extend(
                        {type: ruleType},
                        rule.parse(capture, nestedParse, state)
                    );
                    result.push(parsed);
                    break;
                }
                i++;
            }
            if (i === rules.length) {
                throw new Error(
                    "could not find rule to match content: " + source
                );
            }
        }
        return result;
    };
    return nestedParse;
};

var outputFor = (outputFunc) => {
    var nestedOutput = (ast) => {
        if (_.isArray(ast)) {
            return _.map(ast, nestedOutput);
        } else {
            return outputFunc(ast, nestedOutput);
        }
    };
    return nestedOutput;
};

var parseCapture = (capture, parse, state) => {
    return {
        content: parse(capture[1], state)
    };
};
var ignoreCapture = () => ({});

// recognize a `*` `-`, `+`, `1.`, `2.`... list bullet
var LIST_BULLET = "(?:[*+-]|\\d+\\.)";
// recognize the start of a list item:
// leading space plus a bullet plus a space (`   * `)
var LIST_ITEM_PREFIX = "( *)(" + LIST_BULLET + ") ";
var LIST_ITEM_PREFIX_R = new RegExp("^" + LIST_ITEM_PREFIX);
// recognize an individual list item:
//  * hi
//    this is part of the same item
//
//    as is this, which is a new paragraph in the same item
//
//  * but this is not part of the same item
var LIST_ITEM_R = new RegExp(
    LIST_ITEM_PREFIX +
    "[^\\n]*(?:\\n" +
    "(?!\\1" + LIST_BULLET + " )[^\\n]*)*",
    "gm"
);
// recognize the end of a paragraph block inside a list item:
// two or more newlines at end end of the item
var LIST_BLOCK_END_R = /\n{2,}$/;

var LINK_INSIDE = "(?:\\[[^\\]]*\\]|[^\\]]|\\](?=[^\\[]*\\]))*";
var LINK_HREF = "\\s*<?([^\\s]*?)>?(?:\\s+['\"]([\\s\\S]*?)['\"])?\\s*";

var defaultRules = {
    heading: {
        regex: /^ *(#{1,6}) *([^\n]+?) *#* *\n+/,
        parse: (capture, parse, state) => {
            return {
                level: capture[1].length,
                content: parse(capture[2], state)
            };
        },
        output: (node, output) => {
            return React.DOM["h" + node.level](
                null,
                output(node.content)
            );
        }
    },
    lheading: {
        regex: /^([^\n]+)\n *(=|-){3,} *\n+/,
        parse: (capture, parse, state) => {
            return {
                type: "heading",
                level: capture[2] === '=' ? 1 : 2,
                content: parse(capture[1], state)
            };
        }
    },
    hr: {
        regex: /^( *[-*_]){3,} *\n+/,
        parse: () => ({}),
        output: () => <hr />
    },
    codeBlock: {
        regex: /^(?:    [^\n]+\n*)+\n\n/,
        parse: (capture, parse, state) => {
            var content = capture[0]
                .replace(/^    /gm, '')
                .replace(/\n+$/, '');
            return {
                content: content
            };
        },
        output: (node, output) => {
            return <pre><code>{node.content}</code></pre>;
        }
    },
    blockQuote: {
        regex: /^( *>[^\n]+(\n[^\n]+)*\n*)+/,
        parse: (capture, parse, state) => {
            content = capture[0].replace(/^ *> ?/gm, '');
            return {
                content: parse(content, state)
            };
        },
        output: (node, output) => {
            return <blockquote>{output(node.content)}</blockquote>;
        }
    },
    list: {
        regex: new RegExp(
            "^( *)(" + LIST_BULLET + ") " +
            "[\\s\\S]+?(?:\n{2,}(?! )" +
            "(?!\\1" + LIST_BULLET + " )\\n*" +
            // the \\s*$ here is so that we can parse the inside of nested
            // lists, where our content might end before we receive two `\n`s
            "|\\s*$)"
        ),
        parse: (capture, parse, state) => {
            var bullet = capture[2];
            var ordered = bullet.length > 1;
            var items = capture[0].match(LIST_ITEM_R);

            var lastItemWasAParagraph = false;
            var itemContent = _.map(items, (item, i) => {
                // We need to see how far indented this item is:
                var space = LIST_ITEM_PREFIX_R.exec(item)[0].length;
                // And then we construct a regex to "unindent" the subsequent
                // lines of the items by that amount:
                var spaceRegex = new RegExp("^ {1," + space + "}", "gm");

                // Before processing the item, we need a couple things
                var content = (item + "\n")
                         // remove indents on trailing lines:
                        .replace(spaceRegex, '')
                         // remove the bullet:
                        .replace(LIST_ITEM_PREFIX_R, '');

                // Handling "loose" lists, like:
                //
                //  * this is wrapped in a paragraph
                //
                //  * as is this
                //
                //  * as is this
                if (i === items.length - 2) {
                    // We keep track of whether the second to last item is a
                    // block based on whether it ends in two+ newlines...
                    lastItemWasAParagraph =
                            content.search(LIST_BLOCK_END_R) >= 0;
                } else if (i === items.length - 1) {
                    // ...and we consider the last element to be block or not
                    // a block based on that state in the second-to-last item
                    if (!lastItemWasAParagraph) {
                        content = content.replace(LIST_BLOCK_END_R, '');
                    }
                }

                return parse(content, state);
            });

            return {
                ordered: ordered,
                items: itemContent
            };
        },
        output: (node, output) => {
            var listWrapper = node.ordered ? React.DOM.ol : React.DOM.ul;
            return <listWrapper>
                {_.map(node.items, (item) => {
                    return <li>{output(item)}</li>;
                })}
            </listWrapper>;
        }
    },
    paragraph: {
        regex: /^((?:[^\n]|\n[^\n])+)\n\n+/,
        parse: parseCapture,
        output: (node, output) => {
            return <div className="paragraph">{output(node.content)}</div>;
        }
    },
    escape: {
        regex: /^\\([\\`*{}\[\]()#+\-.!_<>~|])/,
        parse: (capture, parse, state) => {
            return {
                type: "text",
                content: capture[1]
            };
        }
    },
    link: {
        regex: new RegExp(
            "^!?\\[(" + LINK_INSIDE + ")\\]\\(" + LINK_HREF + "\\)"
        ),
        parse: (capture, parse, state) => {
            return {
                content: parse(capture[1]),
                target: capture[2]
            };
        },
        output: (node, output) => {
            return <a href={node.target}>
                {output(node.content)}
            </a>;
        }
    },
    strong: {
        regex: /^\*\*([\s\S]+?)\*\*(?!\*)/,
        parse: parseCapture,
        output: (node, output) => {
            return <strong>{output(node.content)}</strong>;
        }
    },
    u: {
        regex: /^__([\s\S]+?)__(?!_)/,
        parse: parseCapture,
        output: (node, output) => {
            return <u>{output(node.content)}</u>;
        }
    },
    em: {
        regex: /^\b_((?:__|[\s\S])+?)_\b|^\*((?:\*\*|[\s\S])+?)\*(?!\*)/,
        parse: (capture, parse, state) => {
            return {
                content: parse(capture[2] || capture[1], state)
            };
        },
        output: (node, output) => {
            return <em>{output(node.content)}</em>;
        }
    },
    del: {
        regex: /^~~(?=\S)([\s\S]*?\S)~~/,
        parse: parseCapture,
        output: (node, output) => {
            return <del>{output(node.content)}</del>;
        }
    },
    inlineCode: {
        regex: /^(`+)\s*([\s\S]*?[^`])\s*\1(?!`)/,
        parse: (capture, parse, state) => {
            return {
                content: capture[2]
            };
        },
        output: (node, output) => {
            return <code>{node.content}</code>;
        }
    },
    newline: {
        regex: /^\n+/,
        parse: ignoreCapture,
        output: (node, output) => " "
    },
    text: {
        // This is finicky since it relies on not matching _ and *
        // If people add other rules like {{refs}}, this will need
        // to be changed/replaced.
        regex: /^[\s\S]+?(?=[\\<!\[_*`]|\n\n| {2,}\n|$)/,
        parse: (capture, parse, state) => {
            return {
                content: capture[0]
            };
        },
        output: (node, output) => {
            return node.content;
        }
    }
};

var defaultPriorities = Object.keys(defaultRules);

var ruleOutput = (rules) => {
    var nestedRuleOutput = (ast, outputFunc) => {
        return rules[ast.type].output(ast, outputFunc);
    };
    return nestedRuleOutput;
};

var defaultParse = parserFor(defaultRules, defaultPriorities);
var defaultOutput = outputFor(ruleOutput(defaultRules));

module.exports = {
    parserFor: parserFor,
    outputFor: outputFor,
    defaultRules: defaultRules,
    defaultPriorities: defaultPriorities,
    ruleOutput: ruleOutput,
    defaultParse: defaultParse,
    defaultOutput: defaultOutput
};