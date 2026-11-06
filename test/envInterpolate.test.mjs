/**
 * `${ENV_VAR}` 环境变量插值 helper 单测
 *
 * 覆盖 utils/envInterpolate.js 的 interpolateEnvVars 四条替换路径：
 *  1. `${VAR}` 替换为对应环境变量的值
 *  2. 未定义变量替换为空串
 *  3. 不含合法 `${VAR}` 占位符的字符串原样返回
 *  4. 非字符串输入原样返回
 *
 * 运行：node --test test/envInterpolate.test.mjs
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { interpolateEnvVars } from '../utils/envInterpolate.js'

/** 生成 `${NAME}` 形状的占位文本（避免与测试文件自身的模板字符串混淆） */
const ph = name => '${' + name + '}'

/** 测试专用环境变量名，机器上不会真实存在，用完即删 */
const VAR = 'CFGP_TEST_ENV_INTERPOLATE_VAR'

afterEach(() => {
  delete process.env[VAR]
})

describe('环境变量插值', () => {
  test('`${VAR}` 替换为对应环境变量的值，多处出现全部替换', () => {
    process.env[VAR] = 'secret-value'
    assert.equal(interpolateEnvVars(`Bearer ${ph(VAR)}`), 'Bearer secret-value')
    assert.equal(interpolateEnvVars(`${ph(VAR)}:${ph(VAR)}`), 'secret-value:secret-value')
  })

  test('未定义变量替换为空串', () => {
    delete process.env[VAR]
    assert.equal(interpolateEnvVars(`Bearer ${ph(VAR)}`), 'Bearer ')
  })

  test('不含合法占位符的字符串原样返回', () => {
    // 纯明文（明文直填密钥是合法用法，必须原样通过）
    assert.equal(interpolateEnvVars('Bearer plain-token.123'), 'Bearer plain-token.123')
    // 非合法占位符形状（`$VAR` 无花括号、`${}` 空名、`${1}` 数字开头）须原样保留，
    // 不能清空——理由见 utils/envInterpolate.js 头注
    assert.equal(
      interpolateEnvVars('x$NOT_A_PLACEHOLDER ${} ${1} y'),
      'x$NOT_A_PLACEHOLDER ${} ${1} y'
    )
  })

  test('非字符串输入原样返回', () => {
    assert.equal(interpolateEnvVars(undefined), undefined)
    assert.equal(interpolateEnvVars(null), null)
    assert.equal(interpolateEnvVars(42), 42)
    const obj = { Authorization: 'Bearer x' }
    assert.equal(interpolateEnvVars(obj), obj)
  })
})
