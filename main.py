import time
import random
import threading
import platform
from tkinter import messagebox
import tkinter as tk
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    WebDriverException,
    TimeoutException,
    NoSuchElementException,
)

# --- Safari Driver Manager ---
class SafariDriverManager:
    """Safari WebDriver 引导管理器"""
    def show_setup_instructions(self):
        """显示一个包含设置步骤的弹窗"""
        instructions = """
        首次使用前，请确保 Safari 浏览器已开启自动化权限：

        步骤 1: 开启 Safari 的“开发”菜单
        - 打开 Safari -> 偏好设置 (或 设置) -> 高级
        - 勾选 “在菜单栏中显示‘开发’菜单”

        步骤 2: 允许远程自动化
        - 在 Safari 的菜单栏中点击 “开发”
        - 勾选 “允许远程自动化”

        完成以上步骤后，程序即可正常控制 Safari。
        """
        messagebox.showinfo("Safari 自动化设置向导", instructions)

# --- 主要自动化逻辑 ---
class AutoClicker:
    def __init__(self):
        self.driver = None
        self.paused = False
        self.stop_flag = False
        self.pause_lock = threading.Condition()
        self.is_running = False

    def start(self, username, password, update_status, custom_interval, book_id, interval):
        """启动自动化流程 (全自动登录版)"""
        try:
            self.is_running = True
            self.stop_flag = False

            if platform.system() != "Darwin":
                raise Exception("此脚本仅支持在 macOS 上运行。")

            update_status("正在启动 Safari 自动化会话...")
            
            try:
                self.driver = webdriver.Safari()
            except WebDriverException as e:
                raise Exception(f"无法启动 Safari 会话。\n请确保已开启'允许远程自动化'。\n\n错误详情: {e}")

            update_status("浏览器启动成功，开始自动登录...")
            
            # 调用全自动登录函数
            self.login(username, password, update_status)
            
            # 开始刷课
            self.navigate_and_click(update_status, custom_interval, book_id, interval)

        except Exception as e:
            error_msg = f"程序错误: {str(e)}"
            print(error_msg)
            update_status(error_msg)
            messagebox.showerror("程序错误", str(e))

        finally:
            self.is_running = False
            if self.driver:
                try:
                    self.driver.quit()
                except:
                    pass
                self.driver = None

    def login(self, username, password, update_status):
        """执行全自动登录，使用精确的选择器"""
        try:
            update_status("正在访问登录页面...")
            self.driver.get("https://ucloud.unipus.cn/sso/index.html?service=https%3A%2F%2Fucloud.unipus.cn%2Fhome")
            wait = WebDriverWait(self.driver, 20)

            # 1. 填写账号密码
            update_status("填写账号密码...")
            wait.until(EC.visibility_of_element_located((By.ID, "username"))).send_keys(username)
            time.sleep(0.5)
            self.driver.find_element(By.ID, "password").send_keys(password)
            time.sleep(0.5)

            # 2. 自动勾选用户协议
            update_status("勾选用户协议...")
            try:
                agreement_label = wait.until(
                    EC.element_to_be_clickable((By.XPATH, "//label[.//input[@id='agreement']]"))
                )
                self.driver.execute_script("arguments[0].click();", agreement_label)
                time.sleep(0.5)
            except Exception as e:
                raise Exception(f"自动勾选用户协议失败: {e}")

            # 3. 自动点击登录按钮 (*** 已根据您提供的源码修正 ***)
            update_status("点击登录按钮...")
            try:
                # 使用唯一的class name "usso-login-btn" 来精确定位
                login_button = wait.until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, "button.usso-login-btn"))
                )
                login_button.click()
            except Exception as e:
                 raise Exception(f"点击登录按钮失败: {e}")

            # 4. 等待登录成功跳转
            update_status("等待登录成功...")
            self.wait_for_login_success(update_status)
            update_status("登录成功，准备进入课程...")

        except TimeoutException:
            raise Exception("登录页面加载超时或元素未找到。")
        except Exception as e:
            raise Exception(f"登录过程中发生错误: {e}")

    def wait_for_login_success(self, update_status):
        """等待登录成功，检查URL是否已跳转"""
        max_wait_time = 60
        start_time = time.time()
        while time.time() - start_time < max_wait_time:
            if "home" in self.driver.current_url or "sso" not in self.driver.current_url:
                time.sleep(2)
                return
            time.sleep(1)
        raise Exception("等待登录超时，请检查账号密码是否正确。")

    def navigate_and_click(self, update_status, custom_interval, book_id, interval):
        try:
            update_status("正在进入课程页面...")
            course_url = f"https://ucloud.unipus.cn/app/cmgt/resource-detail/{book_id}"
            self.driver.get(course_url)
            time.sleep(5)
            update_status("页面滚动中...")
            self.driver.execute_script("window.scrollBy(0, 300);")
            time.sleep(3)
            self.click_button_safe("button.ant-btn.ant-btn-default.courses-info_buttonLayer1__Mtel4 span", "课程按钮")
            time.sleep(3)
            self.click_button_safe("div.know-box span.iKnow", "知识点按钮")
            time.sleep(3)
            self.click_button_safe("button.ant-btn.ant-btn-primary span", "确认按钮")
            time.sleep(3)
            self.handle_popup_dialogs(update_status)
            time.sleep(2)
            update_status("获取课程菜单...")
            buttons = WebDriverWait(self.driver, 30).until(
                EC.presence_of_all_elements_located((By.CSS_SELECTOR, "div.pc-slider-menu-micro.pc-menu-default"))
            )
            update_status(f"找到 {len(buttons)} 个课程项目，从第 {custom_interval + 1} 个开始")
            time.sleep(2)
            for index, button in enumerate(buttons[custom_interval:], start=custom_interval):
                if self.stop_flag:
                    update_status("操作已停止")
                    break
                try:
                    self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", button)
                    time.sleep(2)
                    button.click()
                    current_task = button.text.strip() or f"课程项目 {index + 1}"
                    update_status(f"正在学习: {current_task}")
                    time.sleep(3)
                    self.click_button_safe("button.ant-btn.ant-btn-primary span", "继续学习按钮")
                    time.sleep(2)
                    self.handle_popup_dialogs(update_status)
                    random_interval = max(30, interval + random.randint(-20, 20))
                    self.wait_with_update(random_interval, update_status, current_task)
                    time.sleep(30)
                except Exception as e:
                    error_msg = f"处理第 {index + 1} 个项目时出错: {e}"
                    print(error_msg)
                    update_status(error_msg)
                    time.sleep(5)
                    continue
            if not self.stop_flag:
                update_status("所有课程项目处理完成！")
        except TimeoutException:
            raise Exception("课程页面加载超时")
        except Exception as e:
            raise Exception(f"导航过程出错: {e}")

    def handle_popup_dialogs(self, update_status):
        popup_button_texts = ['我知道了', '知道了', '确定', '确认', 'OK', '好的', '关闭']
        try:
            for text in popup_button_texts:
                try:
                    buttons = self.driver.find_elements(By.XPATH, f"//button[contains(., '{text}')]")
                    for button in buttons:
                        if button.is_displayed() and button.is_enabled():
                            self.driver.execute_script("arguments[0].click();", button)
                            update_status(f"处理弹窗: 点击了'{text}'按钮")
                            time.sleep(2)
                            return
                except: continue
        except: pass

    def click_button_safe(self, selector, button_name="按钮"):
        try:
            button = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
            )
            self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", button)
            time.sleep(1)
            button.click()
            time.sleep(2)
        except Exception as e:
            print(f"警告: 点击 '{button_name}' ({selector}) 失败或超时. 错误: {e}")

    def wait_with_update(self, interval, update_status, current_task):
        for i in range(interval, 0, -1):
            with self.pause_lock:
                while self.paused and not self.stop_flag:
                    self.pause_lock.wait()
            if self.stop_flag: return
            update_status(f"{current_task}", i)
            time.sleep(1)

    def pause(self): self.paused = True
    def resume(self):
        with self.pause_lock:
            self.paused = False
            self.pause_lock.notify()
    def stop(self):
        self.stop_flag = True
        self.resume()

# --- 全局变量和UI函数 ---
clicker = None
script_thread = None

def start_script():
    try:
        username = txt_username.get().strip()
        password = txt_password.get().strip()
        book_id = txt_book_id.get().strip()
        if not all([username, password, book_id]):
            messagebox.showerror("输入错误", "请填写所有字段！")
            return
        
        custom_interval = int(txt_custom_interval.get() or "0")
        interval = int(txt_interval.get() or "60")
        if custom_interval < 0 or interval < 30:
            messagebox.showerror("输入错误", "转跳不能小于0，时间间隔不能小于30秒！")
            return

        global script_thread, clicker
        if script_thread and script_thread.is_alive():
            messagebox.showwarning("警告", "程序正在运行中！")
            return
        
        clicker = AutoClicker()
        update_status("正在启动...")
        script_thread = threading.Thread(
            target=clicker.start,
            args=(username, password, update_status, custom_interval, book_id, interval),
            daemon=True
        )
        script_thread.start()
        
        btn_start.config(state="disabled")
        btn_stop.config(state="normal")
        btn_pause.config(state="normal")
    except ValueError:
        messagebox.showerror("输入错误", "转跳和时间间隔必须是数字！")
    except Exception as e:
        messagebox.showerror("启动错误", f"启动失败: {str(e)}")

def pause_script():
    if clicker and clicker.is_running:
        clicker.pause()
        update_status("已暂停")
        btn_pause.config(state="disabled")
        btn_resume.config(state="normal")

def resume_script():
    if clicker:
        clicker.resume()
        update_status("已恢复")
        btn_pause.config(state="normal")
        btn_resume.config(state="disabled")

def stop_script():
    if clicker: clicker.stop()
    btn_start.config(state="normal")
    btn_stop.config(state="disabled")
    btn_pause.config(state="disabled")
    btn_resume.config(state="disabled")
    update_status("操作已停止")

def update_status(current_task, countdown=0):
    try:
        if countdown > 0:
            lbl_status.config(text=f"当前操作: {current_task}")
            lbl_countdown.config(text=f"下一个操作倒数: {countdown} 秒")
        else:
            lbl_status.config(text=f"当前操作: {current_task}")
            lbl_countdown.config(text="下一个操作倒数: 无")
    except: pass

def show_safari_setup_help():
    SafariDriverManager().show_setup_instructions()

def create_ui():
    window = tk.Tk()
    window.title("Unipus自动刷课 (macOS Safari全自动版)")
    window.geometry("400x650")
    window.attributes("-topmost", True)
    window.resizable(False, False)
    
    global txt_username, txt_password, txt_book_id, txt_custom_interval, txt_interval
    global lbl_status, lbl_countdown
    global btn_start, btn_stop, btn_pause, btn_resume
    
    frame_driver_info = tk.Frame(window, relief=tk.RAISED, bd=1)
    frame_driver_info.pack(fill=tk.X, padx=10, pady=10)
    lbl_driver_title = tk.Label(frame_driver_info, text=" Safari WebDriver 设置", font=("Arial", 10, "bold"))
    lbl_driver_title.pack(pady=2)
    lbl_driver_info = tk.Label(frame_driver_info, text="✅ 使用系统自带驱动，无需下载\n⚠️ 首次运行需按说明开启Safari自动化权限", fg="blue", font=("Arial", 8))
    lbl_driver_info.pack(pady=2)
    btn_check_driver = tk.Button(frame_driver_info, text="查看配置说明", command=show_safari_setup_help, width=15)
    btn_check_driver.pack(pady=5)
    
    lbl_username = tk.Label(window, text="手机号:")
    lbl_username.pack(anchor="w", padx=10, pady=(10, 0))
    txt_username = tk.Entry(window, width=45)
    txt_username.pack(padx=10, pady=2)
    
    lbl_password = tk.Label(window, text="密码:")
    lbl_password.pack(anchor="w", padx=10, pady=(5, 0))
    txt_password = tk.Entry(window, width=45, show="*")
    txt_password.pack(padx=10, pady=2)
    
    lbl_book_id = tk.Label(window, text="课本ID:")
    lbl_book_id.pack(anchor="w", padx=10, pady=(5, 0))
    txt_book_id = tk.Entry(window, width=45)
    txt_book_id.pack(padx=10, pady=2)
    
    lbl_custom_interval = tk.Label(window, text="从第几个开始 (默认0):")
    lbl_custom_interval.pack(anchor="w", padx=10, pady=(5, 0))
    txt_custom_interval = tk.Entry(window, width=45)
    txt_custom_interval.insert(0, "0")
    txt_custom_interval.pack(padx=10, pady=2)
    
    lbl_interval = tk.Label(window, text="时间间隔 (秒，最小30):")
    lbl_interval.pack(anchor="w", padx=10, pady=(5, 0))
    txt_interval = tk.Entry(window, width=45)
    txt_interval.insert(0, "60")
    txt_interval.pack(padx=10, pady=2)
    
    frame_buttons = tk.Frame(window)
    frame_buttons.pack(pady=20)
    btn_start = tk.Button(frame_buttons, text="开始", command=start_script, width=10, bg="#4CAF50", fg="white")
    btn_start.pack(side=tk.LEFT, padx=5)
    btn_pause = tk.Button(frame_buttons, text="暂停", command=pause_script, width=10, state="disabled")
    btn_pause.pack(side=tk.LEFT, padx=5)
    btn_resume = tk.Button(frame_buttons, text="继续", command=resume_script, width=10, state="disabled")
    btn_resume.pack(side=tk.LEFT, padx=5)
    btn_stop = tk.Button(frame_buttons, text="停止", command=stop_script, width=10, bg="#f44336", fg="white", state="disabled")
    btn_stop.pack(side=tk.LEFT, padx=5)
    
    lbl_status = tk.Label(window, text="当前操作: 无", fg="blue", wraplength=350)
    lbl_status.pack(pady=5)
    lbl_countdown = tk.Label(window, text="下一个操作倒数: 无", fg="green")
    lbl_countdown.pack(pady=2)
    
    usage_text = ("📝 使用说明:\n"
                  "1. 填写您的账号、密码和课本ID\n"
                  "2. 点击“开始”按钮\n"
                  "3. 脚本将自动打开Safari窗口并完成所有操作\n"
                  "4. 请勿手动操作自动化窗口，以免干扰脚本")
    lbl_usage = tk.Label(window, text=usage_text, fg="gray", justify=tk.LEFT)
    lbl_usage.pack(padx=10, pady=10, fill=tk.X)
    
    def on_closing():
        if clicker and clicker.is_running:
            if messagebox.askokcancel("退出", "程序正在运行，确定要退出吗？"):
                stop_script()
                window.destroy()
        else:
            window.destroy()
    
    window.protocol("WM_DELETE_WINDOW", on_closing)
    window.mainloop()

if __name__ == "__main__":
    try:
        if platform.system() != "Darwin":
             messagebox.showerror("系统不兼容", "此程序专为 macOS 设计，无法在当前系统上运行。")
        else:
            create_ui()
    except Exception as e:
        print(f"程序启动失败: {str(e)}")
        messagebox.showerror("启动错误", f"程序启动失败:\n{str(e)}")
